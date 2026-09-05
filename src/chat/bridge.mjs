import { parseCommand, commandOwner, commandHelp } from './commands.mjs';
import { executeUsage } from './usage.mjs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { AttentionClient } from './attention-client.mjs';
import { ChatStore, stableId } from './store.mjs';
import { allowed, splitText, validateConfig } from './policy.mjs';
import { outputFiles, outputParts } from './files.mjs';
import { prepareText, editableIntermediateHeadText, composeEditableMessageText, normalizeAssistantSummaryText, stripMarkdownFormatting } from './presentation.mjs';
import { resolveWorking, workingFrame } from './working.mjs';

export class ChatBridge {
  constructor(config, { codex, adapterFactory, log = console, store, usage = executeUsage } = {}) {
    this.config = validateConfig(config);
    this.log = log;
    this.usage = usage;
    this.store = store || new ChatStore(resolve(config.dataDir, 'chat.sqlite'));
    this.attention = config.attention?.nerveConfig ? new AttentionClient(config.attention.nerveConfig,this.store,{log}) : null;
    if(this.store.cursor('bindings')) this.config.bindings=this.store.cursor('bindings');
    validateConfig(this.config);
    this.codex = codex;
    this.codex.getCursor = key => this.store.cursor(key);
    this.codex.setCursor = (key,value) => this.store.setCursor(key,value);
    this.adapterFactory = adapterFactory;
    this.adapters = new Map();
    this.items = new Map(this.store.cursor('public-items') || []);
    this.finalizedTurns = new Set(this.store.cursor('finalized-turns') || []);
    this.active = new Set();
    this.faultedThreads = new Set();
    this.retryAt = new Map();
    this.lastTypingAt = new Map();
    this.working = resolveWorking(this.config.display?.working);
    this.workingTimers = new Map();
    this.running = false;
    this.flushing = false;
    this.submitting = false;
  }
  routeKey(binding) { return JSON.stringify([binding.adapter, String(binding.chatId)]); }
  route(key) { return this.config.bindings.find(b => this.routeKey(b) === key); }
  attachmentRoots(threadId) {
    return [...(this.config.attachmentRoots || [this.config.dataDir]),
      resolve(this.config.codex?.codexHome || resolve(homedir(),'.codex'),'generated_images',threadId)];
  }
  async start() {
    this.running = true;
    this.codex.onEvent = event => this.event(event);
    await this.codex.start();
    for (const config of this.config.adapters.filter(a => a.enabled !== false)) {
      const adapter = await this.adapterFactory(config, {
        dataDir: this.config.dataDir, log: this.log,
        getCursor: key => this.store.cursor(key),
        setCursor: (key,value) => this.store.setCursor(key,value),
        observeDiscord: this.attention ? record => this.attention.observe(record) : undefined,
        isCommand: message => Boolean(parseCommand(message.text)),
        isBound: message => Boolean(parseCommand(message.text)) || (!(this.attention && config.type==='discord') && this.config.bindings.some(b=>b.adapter===config.id && String(b.chatId)===String(message.chatId) && b.kind===message.kind)),
      });
      this.adapters.set(config.id, adapter);

    }
    for (const threadId of new Set(this.config.bindings.filter(b=>this.adapters.has(b.adapter)).map(b=>b.threadId))) await this.codex.watch?.(threadId);
    for (const config of this.config.adapters.filter(a => this.adapters.has(a.id))) {
      await this.adapters.get(config.id).start(message => this.receive(config,message));
      this.log.info('adapter started',{id:config.id,type:config.type});
    }
    this.timer = setInterval(() => {
      this.submit().catch(e=>this.log.error('submit failed', e));
      this.flush().catch(e=>this.log.error('delivery failed',e));
      this.attention?.flush().catch(e=>this.log.error('attention forwarding failed',e));
    }, 1000);
    this.typingTimer = setInterval(() => this.typing(), 1000);
    await this.submit();
  }
  async receive(config, message) {
    if (!allowed(config,message)) return;
    if(await this.command(config,message))return;
    const binding = this.config.bindings.find(b => b.adapter === config.id && String(b.chatId) === String(message.chatId) && b.kind === message.kind);
    if (!binding) { this.log.warn('message ignored: chat has no explicit binding', {adapter:config.id,chatId:message.chatId}); return; }
    const admitted = this.store.admit(config.id,binding.threadId,message);
    this.store.setCursor(`reply:${this.routeKey(binding)}`,{messageId:message.id,userId:message.userId});
    if (admitted.fresh) {
      // A durable admission only confirms that Rin accepted the message. Give the
      // user one prompt typing hint, but wait for Codex to confirm actual work
      // before the periodic typing loop treats the thread as active.
      this.typing(binding.threadId);
      // Admission is durable before acknowledging a platform cursor. Submission runs separately.
      queueMicrotask(()=>this.submit().catch(e=>this.log.error('submit failed',e)));
    }
  }
  async command(config,message) {
    const command=parseCommand(message.text);
    if(!command)return false;
    // Claim before awaiting or mutating bindings, so duplicate events cannot act twice.
    const key=`command:${stableId(config.id,message.chatId,message.id)}`;
    if(this.store.cursor(key))return true;
    this.store.setCursor(key,{state:'started'});
    const current=this.config.bindings.find(b=>b.adapter===config.id && String(b.chatId)===String(message.chatId));
    const owner=commandOwner(config,message.userId);
    let output;
    try {
      if(command.name==='help') output={text:commandHelp(message.kind==='dm')};
      else if(command.name==='status') output={text:current?'本聊天已连接。':'本聊天尚未连接。'};
      else if(!owner) output={text:config.ownerUsers===undefined && config.allowUsers?.length!==1?'尚未配置主人身份，暂不能使用此命令。':'此命令仅供主人使用。'};
      else if(command.name==='usage') output=message.kind!=='dm'
        ? {text:'请在私聊中使用 /usage 查看用量。'}
        : await this.usage(command.args,{config:this.config.codex || {},dataDir:this.config.dataDir});
      else if(command.name==='unbind') {
        if(current)this.stopWorkingRotation(current.threadId);
        this.config.bindings=this.config.bindings.filter(b=>b!==current);this.store.setCursor('bindings',this.config.bindings);
        output={text:'已解除本聊天的连接。'};
      } else {
        const threadId=command.args;
        if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId)) output={text:'用法：/bind <已有任务 ID>'};
        else if(this.config.bindings.some(b=>b.threadId===threadId && b!==current)) output={text:'该任务已连接其他聊天，请先解除原连接。'};
        else {
          await this.codex.watch(threadId);
          this.faultedThreads.delete(threadId);
          this.config.bindings=this.config.bindings.filter(b=>b!==current);
          this.config.bindings.push({adapter:config.id,chatId:String(message.chatId),kind:message.kind,userId:message.userId,threadId,mirror:true});
          this.store.setCursor('bindings',this.config.bindings);
          output={text:'已连接。后续公开回复会同步到本聊天，已有历史不会回放。'};
        }
      }
    } catch {
      this.log.warn('command failed',{name:command.name});
      output={text:command.name==='usage'?'暂时无法读取用量，请稍后重试。':'命令未完成，请检查输入后重试。'};
    }
    const target={chatId:message.chatId,kind:message.kind,userId:message.userId,messageId:message.id,
      ...(message.commandInteraction?{commandInteraction:{id:message.commandInteraction.id}}:{})};
    const chunks=['discord','telegram'].includes(config.type)
      ? prepareText(config.type,output.text || '',this.adapters.get(config.id)?.capabilities.maxText || 1900)
      : splitText(stripMarkdownFormatting(output.text || ''),1900).map(text=>({text}));
    // Native interaction replies are one private response; adapters retain the handle in memory.
    const parts=message.commandInteraction?[{text:output.text,...(output.files?.length?{files:output.files}:{})}]
      : [...chunks,...(output.files?.length?[{files:output.files}]:[])];
    for(const [index,part] of parts.entries())this.store.stage(stableId(key,index),JSON.stringify([config.id,String(message.chatId)]),{...part,target});
    this.store.setCursor(key,{state:'done'});
    if(message.commandInteraction)await this.flush();
    return true;
  }

  async submit() {
    if (this.submitting || !this.running) return;
    this.submitting = true;
    try {
      for (const job of this.store.pending()) {
        if (!this.running) break;
        if(this.faultedThreads.has(job.thread)) continue;
        this.store.inboxState(job.id,'submitting');
        const message = JSON.parse(job.payload);
        try {
          const receipt = await this.codex.queue(job.thread,{text:message.text,files:message.files || []});
          const appIpc=receipt?.transport?.startsWith('app-ipc-');
          const state=receipt?.transport==='app-ipc-steer' ? 'steered' : appIpc ? 'delivered' : 'queued';
          this.store.inboxState(job.id,state,typeof receipt === 'string' ? receipt : JSON.stringify(receipt));
          if(appIpc) {
            this.active.add(job.thread);
            if(receipt.turnId) for(const binding of this.config.bindings.filter(b=>b.threadId===job.thread && b.mirror===true && this.adapters.has(b.adapter))) {
              const [adapterId]=JSON.parse(job.id);
              const context=binding.adapter===adapterId && String(binding.chatId)===String(message.chatId)
                ? {messageId:message.id,userId:message.userId}
                : this.store.cursor(`reply:${this.routeKey(binding)}`) || {};
              this.stageWorkingMarker(binding,receipt.turnId,context);
            }
          }
          this.log.info('message submitted', {threadId:job.thread,transport:receipt?.transport || 'native-queue'});
        } catch (error) {
          // A lost CLI response may follow a successful submission. Do not replay it automatically.
          this.store.inboxState(job.id,'uncertain',null,'Codex submission failed; inspect redacted service log');
          const [adapterId] = JSON.parse(job.id);
          const binding=this.config.bindings.find(b=>b.adapter===adapterId && String(b.chatId)===String(message.chatId) && b.kind===message.kind);
          if(binding) {
            const unsupported=error?.code==='CODEX_INPUT_UNSUPPORTED' || error?.cause?.code==='CODEX_INPUT_UNSUPPORTED';
            const text=unsupported
              ? '暂不支持发送附件，请先发送文字消息。'
              : '消息投递未确认。为避免重复，我不会自动重发。';
            this.store.stage(stableId('submission-error',job.id),this.routeKey(binding),{
              text,replyTo:message.id,
              target:{chatId:message.chatId,kind:message.kind,userId:message.userId,messageId:message.id},
            });
          }
          this.log.error('message submission uncertain; inspect before retry',error);
        }
      }
    } finally { this.submitting = false; }
  }
  event(event) {
    if (!event.threadId) return;
    if(event.type==='observerError') {this.log.error('Codex observer stopped',event.error || event.text || 'unsupported history');this.stopWorkingRotation(event.threadId);this.active.delete(event.threadId);this.faultedThreads.add(event.threadId);return;}
    const bindings = this.config.bindings.filter(b=>b.threadId===event.threadId && this.adapters.has(b.adapter) && b.mirror === true);
    if (!bindings.length) return;
    if (event.type === 'image' && event.itemId && event.turnId && typeof event.path === 'string') {
      // Only the App's completed image artifact for this task is eligible;
      // generic tool outputs and artifacts belonging to other tasks stay private.
      const root=resolve(this.config.codex?.codexHome || resolve(homedir(),'.codex'),'generated_images',event.threadId);
      const files=outputFiles(`[image](${encodeURIComponent(event.path)})`,[root]).filter(file=>file.mimeType?.startsWith('image/'));
      if (!files.length) { this.log.error('Generated image cannot be delivered: missing file or invalid task artifact path'); return; }
      for (const binding of bindings) {
        const context=this.store.cursor(`turn-reply:${this.routeKey(binding)}:${event.turnId}`) || this.store.cursor(`reply:${this.routeKey(binding)}`) || {};
        const type=this.config.adapters.find(a=>a.id===binding.adapter)?.type;
        this.store.stage(stableId(this.routeKey(binding),event.turnId,event.itemId,'generated-image'),this.routeKey(binding),{
          files,...(context.messageId?{replyTo:context.messageId}:{}),
          ...(type==='qqbot'?{target:{chatId:binding.chatId,kind:binding.kind,...context}}:{}),
        });
      }
      return;
    }
    if (event.type === 'started') {
      this.active.add(event.threadId);
      this.typing(event.threadId);
      for(const binding of bindings) {
        const key=`turn-reply:${this.routeKey(binding)}:${event.turnId}`;
        if(this.store.cursor(key)===undefined)this.store.setCursor(key,this.store.cursor(`reply:${this.routeKey(binding)}`) || {});
        if(this.adapters.get(binding.adapter).capabilities.edit) {
          this.stageText(binding,{threadId:event.threadId,turnId:event.turnId,itemId:'progress',phase:'working',text:workingFrame(this.working)},false);
          this.startWorkingRotation(binding,event.threadId,event.turnId);
        }
        else this.stageWorkingMarker(binding,event.turnId,this.store.cursor(key) || {});
      }
    }
    if (event.type === 'text') {
      if(event.phase==='question') {
        if(event.text && event.itemId)for(const binding of bindings)this.stageText(binding,event,true);
        return;
      }
      if(!event.phase)event={...event,phase:'final'};
      if(event.phase==='summary' || event.phase==='reasoning_summary')event={...event,text:normalizeAssistantSummaryText(event.text)};
      if(event.phase==='final_answer') event={...event,phase:'final'};
      if(event.phase==='reasoning_summary') event={...event,phase:'summary'};
      if (!['commentary','final','summary'].includes(event.phase || 'final')) return;
      if (event.phase==='summary' && this.config.display?.summaries === false) return;
      const turnKey=JSON.stringify([event.threadId,event.turnId]);
      if(event.phase !== 'final' && this.finalizedTurns.has(turnKey))return;
      if(event.phase === 'final') {
        this.stopWorkingRotation(event.threadId,event.turnId);
        this.finalizedTurns.add(turnKey);
        this.store.setCursor('finalized-turns',[...this.finalizedTurns]);
      }
      if(event.phase==='summary' && !event.text)return;
      const itemId = event.itemId || event.turnId;
      if (!itemId) return;
      const key = JSON.stringify([event.threadId,event.turnId,itemId]);
      const old = this.items.get(key) || {text:'',phase:event.phase || 'final',turnId:event.turnId,threadId:event.threadId,itemId};
      old.phase = event.phase;
      old.text = event.delta !== undefined ? old.text+event.delta : (event.text ?? old.text);
      // A subsequent public item closes the preceding message on transports without edits.
      if(!this.items.has(key)) for(const previous of this.items.values()) {
        if(previous.threadId===event.threadId && previous.turnId===event.turnId)
          for(const binding of bindings) if(!this.adapters.get(binding.adapter).capabilities.edit) this.stageText(binding,previous,true);
      }
      this.items.set(key,old);
      this.store.setCursor('public-items',[...this.items]);
      for (const binding of bindings) this.stageText(binding,old,event.done === true || event.delta === undefined);
    }
    if (event.type === 'completed' || event.type === 'failed') {
      this.stopWorkingRotation(event.threadId,event.turnId);
      for (const [key,item] of this.items) {
        if (item.threadId !== event.threadId || (event.turnId && item.turnId !== event.turnId)) continue;
        for (const binding of bindings) this.stageText(binding,item,true);
      }
      for(const [key,item] of this.items) if(item.threadId===event.threadId && (!event.turnId || item.turnId===event.turnId))this.items.delete(key);
      if (event.type === 'failed') {
        for (const binding of bindings) this.store.stage(stableId(this.routeKey(binding),event.turnId,'failure'),this.routeKey(binding),{text:'本轮执行未完成，请在 Codex 中查看错误后继续。'});
      }
      this.store.setCursor('public-items',[...this.items]);
      this.active.delete(event.threadId);
    }
  }
  stageWorkingMarker(binding,turnId,context) {
    const adapter=this.adapters.get(binding.adapter);
    if(!adapter || adapter.capabilities.edit || adapter.capabilities.reaction) return;
    if(this.finalizedTurns.has(JSON.stringify([binding.threadId,turnId])))return;
    const route=this.routeKey(binding);
    this.store.stage(stableId(route,turnId,context.messageId || 'chat','working-marker'),route,{
      text:workingFrame(this.working),
      ...(context.messageId?{replyTo:context.messageId}:{}),
      target:{chatId:binding.chatId,kind:binding.kind,...context},
    });
  }

  stageText(binding,item,done) {
    const adapter = this.adapters.get(binding.adapter);
    if (!adapter.capabilities.edit && !done) return;
    const type=this.config.adapters.find(a=>a.id===binding.adapter)?.type;
    const replyKey=`turn-reply:${this.routeKey(binding)}:${item.turnId}`;
    if(this.store.cursor(replyKey)===undefined)this.store.setCursor(replyKey,this.store.cursor(`reply:${this.routeKey(binding)}`) || {});
    const replyContext=this.store.cursor(replyKey) || {};
    const replyTo=replyContext.messageId;
    const targetContext=type==='qqbot' ? {target:{chatId:binding.chatId,kind:binding.kind,...replyContext}} : {};
    const progressScope=type==='telegram' ? 'chat' : (replyTo ? `quote:${replyTo}` : 'chat');
    const baseProgressGroup=stableId(this.routeKey(binding),'progress',progressScope);
    const segmentKey=`progress-segments:${this.routeKey(binding)}:${item.turnId}`;
    const segments=this.store.cursor(segmentKey) || {current:0,questions:[],items:{},groups:[]};
    let progressGroup=segments.current===0 ? baseProgressGroup : stableId(baseProgressGroup,item.turnId,'segment',segments.current);
    if(adapter.capabilities.edit && item.phase==='question' && !segments.questions.includes(item.itemId)) {
      // Questions remain in the timeline. Later progress must appear below them.
      segments.questions.push(item.itemId);
      segments.current++;
      this.store.setCursor(segmentKey,segments);
    }
    if(adapter.capabilities.edit && item.phase!=='question') {
      if(item.phase==='final') {
        for(const group of new Set([baseProgressGroup,...segments.groups])) {
          this.store.retire(group,[]);
          this.store.setCursor(`progress-sections:${group}`,{});
        }
        // Clear the same turn's progress created by the initial turn-keyed deployment.
        this.store.retire(stableId(this.routeKey(binding),item.turnId,'progress'),[]);
        this.store.setCursor(`progress-sections:${progressGroup}`,{});
      } else {
        if(this.finalizedTurns.has(JSON.stringify([item.threadId,item.turnId])))return;
        const itemSegment=segments.items[item.itemId];
        // Working frames always belong to the current progress segment. Public
        // items retain their original segment when history is replayed.
        if(item.phase!=='working' && itemSegment!==undefined && itemSegment!==segments.current)return;
        if(item.phase!=='working')segments.items[item.itemId]=segments.current;
        if(!segments.groups.includes(progressGroup))segments.groups.push(progressGroup);
        this.store.setCursor(segmentKey,segments);
        const sections=this.store.cursor(`progress-sections:${progressGroup}`) || {};
        if(item.phase==='working')sections.working=item.text || workingFrame(this.working);
        else sections[item.phase]=item.text;
        this.store.setCursor(`progress-sections:${progressGroup}`,sections);
        item={...item,itemId:'progress',text:composeEditableMessageText({
          workingTextChunks:[editableIntermediateHeadText(sections.summary || sections.working || workingFrame(this.working))],
          contentTextChunks:sections.commentary ? [sections.commentary] : [],
          todoTextChunks:sections.todo ? [sections.todo] : [],
        })};
      }
    }
    if(item.phase==='final' || item.phase==='question' || (!adapter.capabilities.edit && done)) {
      const group=stableId(this.routeKey(binding),item.turnId,item.itemId,...(!adapter.capabilities.edit ? [item.text] : []));
      const liveIds=[];
      let first=true;
      const parts=outputParts(item.text,this.attachmentRoots(item.threadId));
      for(const [index,part] of parts.entries()) {
        if(part.text && !adapter.capabilities.edit && !['final','question'].includes(item.phase))part.text=editableIntermediateHeadText(part.text);
        if(part.text && ['qqbot','onebot'].includes(type))part.text=stripMarkdownFormatting(part.text);
        const outputs=part.files ? [part] : ['discord','telegram'].includes(type)
          ? prepareText(type,part.text,adapter.capabilities.maxText || 1900)
          : splitText(part.text,adapter.capabilities.maxText || 1900).map(text=>({text}));
        for(const [chunk,output] of outputs.entries()) {
          const id=stableId(group,'part',index,chunk,output.files?.[0]?.path || 'text');
          liveIds.push(id);
          this.store.stage(id,this.routeKey(binding),{...output,...targetContext,...(first && replyTo?{replyTo}:{})},group);
          first=false;
        }
      }
      if(adapter.capabilities.edit && typeof adapter.delete==='function')this.store.retire(group,liveIds);
      return;
    }
    const progress=adapter.capabilities.edit && item.itemId==='progress';
    const sourceText=!adapter.capabilities.edit && ['commentary','summary'].includes(item.phase) ? editableIntermediateHeadText(item.text) : item.text;
    const chunks = ['discord','telegram'].includes(type)
      ? prepareText(type,sourceText,adapter.capabilities.maxText || 1900)
      : splitText(sourceText,adapter.capabilities.maxText || 1900).map(text=>({text}));
    const group=progress ? progressGroup : stableId(this.routeKey(binding),item.turnId,item.itemId);
    const liveIds=[];
    for (let i=0;i<chunks.length;i++) {
      const id=progress ? stableId(group,i) : stableId(this.routeKey(binding),item.turnId,item.itemId,i);liveIds.push(id);
      this.store.stage(id,this.routeKey(binding),{...chunks[i],...targetContext,...(progress?{progress:true}:{}),...(i===0 && replyTo ? {replyTo} : {})},group);
    }
    if(typeof adapter.delete==='function')this.store.retire(group,liveIds);
    if(done) for(const file of outputFiles(item.text,this.attachmentRoots(item.threadId))) {
      this.store.stage(stableId(this.routeKey(binding),item.turnId,item.itemId,'file',file.path),this.routeKey(binding),{files:[file]});
    }
  }
  startWorkingRotation(binding,threadId,turnId) {
    const key=JSON.stringify([this.routeKey(binding),turnId]);
    if(this.workingTimers.has(key) || this.working.frames.length<2)return;
    let index=0;
    const timer=setInterval(()=>{
      if(!this.running || !this.active.has(threadId) || this.finalizedTurns.has(JSON.stringify([threadId,turnId])))return this.stopWorkingRotation(threadId,turnId);
      index=(index+1)%this.working.frames.length;
      this.stageText(binding,{threadId,turnId,itemId:'progress',phase:'working',text:workingFrame(this.working,index)},false);
      this.flush().catch(error=>this.log.error('working status delivery failed',error));
    },this.working.intervalMs);
    timer.unref?.();
    this.workingTimers.set(key,{timer,threadId,turnId});
  }
  stopWorkingRotation(threadId,turnId) {
    for(const [key,state] of this.workingTimers) {
      if(state.threadId!==threadId || (turnId && state.turnId!==turnId))continue;
      clearInterval(state.timer);this.workingTimers.delete(key);
    }
  }
  async flush() {
    if (this.flushing || !this.running) return;
    this.flushing = true;
    try {
      for (const item of this.store.outgoing()) {
        if (!this.running) break;
        if((this.retryAt.get(item.id)?.at || 0)>Date.now())continue;
        const payload = JSON.parse(item.payload);
        const route = this.route(item.route) || (payload.target && {...payload.target,adapter:JSON.parse(item.route)[0]}); const adapter = this.adapters.get(route?.adapter);
        if (!adapter) continue;
        this.store.sending(item.id);
        try {
          const target = {...route,...this.store.cursor(`reply:${item.route}`),...payload.target};
          if(payload.delete) {if(item.message_id)await adapter.delete(target,item.message_id);this.store.sent(item.id,item.payload,null);continue;}
          const sent = await adapter.send(target,{...payload,...(item.message_id && adapter.capabilities.edit ? {editId:item.message_id} : {})});
          this.store.sent(item.id,item.payload,sent.id);
          this.retryAt.delete(item.id);
          if(payload.progress && route.threadId)this.typing(route.threadId);
        } catch (error) {
          // Editing an identified message is safe to retry; a first send with unknown outcome isn't.
          this.store.failed(item.id,'Platform delivery failed; inspect redacted service log',Boolean(item.message_id) && error?.deliveryUncertain !== true);
          const delay=Math.min(30000,(this.retryAt.get(item.id)?.delay || 500)*2);
          this.retryAt.set(item.id,{delay,at:Date.now()+delay});
          this.log.error('outbound delivery failed',error);
        }
      }
    } finally { this.flushing = false; }
  }
  typing(threadId) {
    for (const b of this.config.bindings) {
      if (threadId ? b.threadId !== threadId : !this.active.has(b.threadId)) continue;
      const a = this.adapters.get(b.adapter);
      const config=this.config.adapters.find(a=>a.id===b.adapter);
      const now=Date.now();
      const interval=config?.type==='telegram'?4000:config?.type==='discord'?9000:30000;
      if(!threadId && now-(this.lastTypingAt.get(this.routeKey(b)) || 0)<interval)continue;
      this.lastTypingAt.set(this.routeKey(b),now);
      if (a?.capabilities.typing && !(config?.type==='qqbot' && b.kind==='group')) a.typing({...b,...this.store.cursor(`reply:${this.routeKey(b)}`)}).catch(e=>this.log.warn('typing failed',e));
    }
  }
  async stop() {
    this.running = false; clearInterval(this.timer); clearInterval(this.typingTimer);
    for(const {timer} of this.workingTimers.values())clearInterval(timer);
    this.workingTimers.clear();
    this.attention?.stop();
    await Promise.allSettled([...this.adapters.values()].map(a=>a.stop()));
    await this.codex.stop();
    const deadline = Date.now()+15000;
    while ((this.flushing || this.submitting || this.attention?.busy) && Date.now()<deadline) await new Promise(r=>setTimeout(r,50));
    if (!this.flushing && !this.submitting && !this.attention?.busy) this.store.close();
  }
}
