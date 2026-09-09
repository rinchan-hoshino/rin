import type { ChatConfig, AdapterConfig, ChatMessage, ChatTarget, ChatOutput, Binding, ChatCommand, CommandContext, Logger, AdapterContext, ChatAdapter, PublicItem } from './types.js';
import type {AgentBridge,AgentEvent} from '../agents/types.js';
type AutoBindingState = {state: 'bound'; binding: Binding} | {state: 'creating' | 'uncertain'};
type AutoBindings = Record<string, AutoBindingState>;
interface Segments { current: number; questions: string[]; items: Record<string, number>; groups: string[]; }
interface Presentation { id: string; turnId: string; context: Partial<ChatTarget>; inputId?: string; boundary?: number; }
interface Presentations { currentId?: string; entries: Record<string, Presentation>; }
interface ReactionHandle { id: string; target: ChatTarget; }
type InputBoundaries = Record<string, number>;
interface DeferredImage { itemId: string; path: string; ordinal?: number; delivered?: boolean; }
const failure = (error: unknown) => error as {threadId?: string; code?: string; cause?: {code?: string}; fallbackSafe?: boolean; deliveryUncertain?: boolean};
import { COMMANDS, parseCommandText, builtinCommands, commandHelp } from './commands.js';
import { loadCommandExtensions } from './command-extensions.js';
import { resolve } from 'node:path';
import { ChatStore, stableId } from './store.js';
import { allowed, quietFor, splitText, validateConfig } from './policy.js';
import { effectivePrivate } from './private-like.js';
import { outputFiles, outputParts } from './files.js';
import { prepareText, editableIntermediateHeadText, composeEditableMessageText, normalizeAssistantSummaryText, stripMarkdownFormatting } from './presentation.js';
import { resolveWorking, workingFrame } from './working.js';
import { composeInboundText } from './input-normalization.js';

export class ChatBridge {
  config: ChatConfig; log: Logger; commands: ChatCommand[]; store: ChatStore;
  bindingCreations: Map<string, Promise<Binding>>; agent: AgentBridge; adapterFactory: (config: AdapterConfig, context: AdapterContext) => Promise<ChatAdapter> | ChatAdapter;
  adapters: Map<string, ChatAdapter>; items: Map<string, PublicItem>; finalizedTurns: Set<string>; active: Set<string>; faultedThreads: Set<string>;
  retryAt: Map<string, {at: number; delay: number}>; lastTypingAt: Map<string, number>; working: ReturnType<typeof resolveWorking>;
  workingTimers: Map<string, {timer: ReturnType<typeof setInterval>; threadId: string; turnId: string; presentationId: string}>;
  running: boolean; flushing: boolean; submittingThreads: Set<string>; timer?: ReturnType<typeof setInterval>; typingTimer?: ReturnType<typeof setInterval>;
  constructor(config: ChatConfig, { agent, adapterFactory, log = console, store }: {agent: AgentBridge; adapterFactory: ChatBridge['adapterFactory']; log?: Logger; store?: ChatStore}) {
    this.config = validateConfig(config);
    this.log = log;
    this.commands = [];
    this.store = store || new ChatStore(resolve(config.dataDir, 'chat.sqlite'));
    if(this.store.cursor('bindings')) this.config.bindings=this.store.cursor<Binding[]>('bindings')!;
    this.config.bindings=[...this.config.bindings];
    for(const entry of Object.values(this.store.cursor<AutoBindings>('auto-bindings') || {})) {
      if(entry.state==='bound' && !this.config.bindings.some(b=>this.routeKey(b)===this.routeKey(entry.binding))) this.config.bindings.push(entry.binding);
    }
    validateConfig(this.config);
    this.bindingCreations=new Map();
    this.agent = agent;
    if(!this.agent)throw new Error('agent bridge is required');
    this.agent.getCursor = key => this.store.cursor(key);
    this.agent.setCursor = (key,value) => this.store.setCursor(key,value);
    this.adapterFactory = adapterFactory;
    this.adapters = new Map();
    this.items = new Map(this.store.cursor<[string, PublicItem][]>('public-items') || []);
    // A physical turn can contain several accepted chat presentations after steer,
    // so delivery finality is stored per presentation rather than by turnId.
    this.finalizedTurns = new Set(this.store.cursor<string[]>('finalized-turns') || []);
    this.active = new Set();
    this.faultedThreads = new Set();
    this.retryAt = new Map();
    this.lastTypingAt = new Map();
    this.working = resolveWorking(this.config.display?.working);
    this.workingTimers = new Map();
    this.running = false;
    this.flushing = false;
    this.submittingThreads = new Set();
  }
  routeKey(binding: Pick<Binding, 'adapter' | 'chatId' | 'topicId'>) { return binding.topicId ? JSON.stringify([binding.adapter, String(binding.chatId), String(binding.topicId)]) : JSON.stringify([binding.adapter, String(binding.chatId)]); }
  route(key: string) { return this.config.bindings.find(b => this.routeKey(b) === key); }
  presentationKey(binding: Binding) { return `presentations:${this.routeKey(binding)}:${binding.threadId}`; }
  presentations(binding: Binding): Presentations { return this.store.cursor<Presentations>(this.presentationKey(binding)) || {entries:{}}; }
  savePresentations(binding: Binding, state: Presentations) { this.store.setCursor(this.presentationKey(binding),state); }
  presentationFinalKey(binding: Binding, id: string) { return `presentation-final:${this.routeKey(binding)}:${id}`; }
  physicalTerminalKey(threadId: string, turnId: string) { return `physical-terminal:${threadId}:${turnId}`; }
  physicalTerminal(threadId: string, turnId: string) { return this.store.cursor<{type: string}>(this.physicalTerminalKey(threadId,turnId)); }
  presentationItemKey(binding: Binding, item: Pick<PublicItem,'threadId'|'turnId'|'itemId'>) { return `presentation-item:${this.routeKey(binding)}:${item.threadId}:${item.turnId}:${item.itemId}`; }
  inputBoundariesKey(binding: Binding, threadId: string, turnId: string) { return `presentation-inputs:${this.routeKey(binding)}:${threadId}:${turnId}`; }
  inputBoundaries(binding: Binding, threadId: string, turnId: string): InputBoundaries { return this.store.cursor<InputBoundaries>(this.inputBoundariesKey(binding,threadId,turnId)) || {}; }
  saveInputBoundaries(binding: Binding, threadId: string, turnId: string, inputs: InputBoundaries) { this.store.setCursor(this.inputBoundariesKey(binding,threadId,turnId),inputs); }
  expectedInputKey(binding: Binding, id: string) { return `presentation-expected-input:${this.routeKey(binding)}:${binding.threadId}:${id}`; }
  inflightInputKey(binding: Binding, threadId: string) { return `presentation-inflight-input:${this.routeKey(binding)}:${threadId}`; }
  inboundContext(binding: Binding, adapterId: string, message: ChatMessage): Partial<ChatTarget> {
    return binding.adapter===adapterId && String(binding.chatId)===String(message.chatId) && String(binding.topicId || '')===String(message.topicId || '')
      ? {messageId:message.id,userId:message.userId,topicId:message.topicId}
      : this.store.cursor<Partial<ChatTarget>>(`reply:${this.routeKey(binding)}`) || {};
  }
  expectInput(binding: Binding, id: string) { this.store.setCursor(this.expectedInputKey(binding,id),true); }
  expectsInput(binding: Binding, id: string) { return this.store.cursor(this.expectedInputKey(binding,id))===true; }
  imagesKey(binding: Binding, threadId: string, turnId: string) { return `presentation-images:${this.routeKey(binding)}:${threadId}:${turnId}`; }
  deferredImages(binding: Binding, threadId: string, turnId: string) { return this.store.cursor<Record<string,DeferredImage>>(this.imagesKey(binding,threadId,turnId)) || {}; }
  saveDeferredImages(binding: Binding, threadId: string, turnId: string, images: Record<string,DeferredImage>) { this.store.setCursor(this.imagesKey(binding,threadId,turnId),images); }
  activatePresentation(binding: Binding, id: string, turnId: string, context: Partial<ChatTarget>, inputId?: string) {
    const state=this.presentations(binding), previous=state.currentId && state.entries[state.currentId];
    if(previous && previous.id!==id)this.retirePresentationProgress(binding,previous.id);
    state.entries[id]={id,turnId,context,...(inputId?{inputId}:{})};
    // Every accepted input, whether starting or steering, uses its persisted
    // userMessage/clientId boundary to attribute output.
    if(!inputId)state.entries[id].boundary=Number.MIN_SAFE_INTEGER;
    else {
      const boundary=this.inputBoundaries(binding,binding.threadId,turnId)[inputId];
      if(Number.isFinite(boundary))state.entries[id].boundary=boundary;
      this.store.setCursor(this.expectedInputKey(binding,inputId),false);
    }
    state.currentId=id;this.savePresentations(binding,state);
    this.store.setCursor(`turn-reply:${this.routeKey(binding)}:${turnId}`,context);
    const presentation=state.entries[id];
    if(presentation.boundary!==undefined)this.deliverDeferred(binding,presentation);
    return presentation;
  }
  deliverDeferred(binding: Binding, presentation: Presentation) {
    for(const item of this.items.values()) if(item.threadId===binding.threadId && item.turnId===presentation.turnId &&
      !this.store.cursor(this.presentationItemKey(binding,item))) this.stageText(binding,item,true);
    for(const image of Object.values(this.deferredImages(binding,binding.threadId,presentation.turnId))) if(!image.delivered &&
      (image.ordinal===undefined || image.ordinal>=presentation.boundary!)) this.stageImage(binding,{threadId:binding.threadId,turnId:presentation.turnId,...image});
  }
  presentationFor(binding: Binding, item: PublicItem): Presentation | undefined {
    const mapped=this.store.cursor<string>(this.presentationItemKey(binding,item));
    const state=this.presentations(binding);
    if(mapped && state.entries[mapped])return state.entries[mapped];
    // A receipt can precede the observer's userMessage row. Until that row
    // supplies an ordinal, neither a late old item nor a new item may claim a
    // presentation merely because it happened to be observed first.
    if(Object.values(state.entries).some(entry=>entry.turnId===item.turnId && entry.inputId && entry.boundary===undefined))return undefined;
    const ordinal=item.ordinal;
    if(ordinal!==undefined && Object.entries(this.inputBoundaries(binding,item.threadId,item.turnId))
      .some(([id,boundary])=>this.expectsInput(binding,id) && ordinal>=boundary))return undefined;
    const candidates=Object.values(state.entries).filter(entry=>entry.turnId===item.turnId && entry.boundary!==undefined &&
      (item.ordinal===undefined || item.ordinal>=entry.boundary));
    let presentation=candidates.sort((a,b)=>(b.boundary ?? Number.MIN_SAFE_INTEGER)-(a.boundary ?? Number.MIN_SAFE_INTEGER))[0];
    if(!presentation) {
      const id=`turn:${item.turnId}`;
      presentation=state.entries[id] || {id,turnId:item.turnId,context:this.store.cursor<Partial<ChatTarget>>(`turn-reply:${this.routeKey(binding)}:${item.turnId}`) || this.store.cursor<Partial<ChatTarget>>(`reply:${this.routeKey(binding)}`) || {},boundary:Number.MIN_SAFE_INTEGER};
      state.entries[id]=presentation;
      if(!state.currentId)state.currentId=id;
      this.savePresentations(binding,state);
    }
    this.store.setCursor(this.presentationItemKey(binding,item),presentation.id);
    return presentation;
  }
  presentationById(binding: Binding, id: string) { return this.presentations(binding).entries[id]; }
  currentPresentation(binding: Binding) { const state=this.presentations(binding); return state.currentId ? state.entries[state.currentId] : undefined; }
  presentationFinalized(binding: Binding, id: string) { return Boolean(this.store.cursor(this.presentationFinalKey(binding,id))); }
  finalizePresentation(binding: Binding, id: string) { this.store.setCursor(this.presentationFinalKey(binding,id),true); }
  reactionKey(binding: Binding, id: string) { return `presentation-reaction:${this.routeKey(binding)}:${id}`; }
  reactionTarget(binding: Binding, context: Partial<ChatTarget>): ChatTarget {
    return {chatId:binding.chatId,...(binding.topicId?{topicId:binding.topicId}:{}),kind:binding.kind,...context};
  }
  async beginReaction(binding: Binding, presentation: Presentation) {
    if(quietFor(this.config,binding))return;
    const adapter=this.adapters.get(binding.adapter);
    if(!adapter?.capabilities.reaction || !adapter.startReaction || this.presentationFinalized(binding,presentation.id))return;
    const key=this.reactionKey(binding,presentation.id);
    if(this.store.cursor(key)!==undefined)return;
    // Persist a sentinel before the request so duplicate started/receipt events
    // cannot place more than one marker while the platform call is in flight.
    this.store.setCursor(key,'starting');
    const target=this.reactionTarget(binding,presentation.context);
    try {
      const result=await adapter.startReaction(target);
      if(!result.id)throw new Error('reaction returned no id');
      // Retiring, terminal handling, or stop may have happened while the
      // platform was creating the reaction. Remove this late handle directly.
      if(this.store.cursor(key)==='ended') {
        try { await adapter.endReaction?.(target,result.id); }
        catch(error) { this.log.warn('working reaction removal failed',error); }
        return;
      }
      this.store.setCursor(key,{id:result.id,target} satisfies ReactionHandle);
      if(this.presentationFinalized(binding,presentation.id))await this.endReaction(binding,presentation.id);
    } catch(error) {
      if(this.store.cursor(key)==='ended')return;
      this.store.setCursor(key,'failed');
      this.log.warn('working reaction unavailable; using text marker',error);
      this.stageWorkingMarker(binding,presentation.turnId,presentation.context,presentation.id,true);
      this.flush().catch(flushError=>this.log.error('working marker delivery failed',flushError));
    }
  }
  async endReaction(binding: Binding, id: string) {
    const key=this.reactionKey(binding,id), handle=this.store.cursor<ReactionHandle | 'starting' | 'failed' | 'ended' | false>(key);
    if(handle && typeof handle==='object') {
      const adapter=this.adapters.get(binding.adapter);
      try { await adapter?.endReaction?.(handle.target,handle.id); }
      catch(error) { this.log.warn('working reaction removal failed',error); }
    }
    // This state is also a cancellation fence for an in-flight startReaction.
    this.store.setCursor(key,'ended');
  }
  retirePresentationProgress(binding: Binding, id: string) {
    this.endReaction(binding,id).catch(error=>this.log.warn('working reaction cleanup failed',error));
    for(const group of this.store.cursor<string[]>(`presentation-progress-groups:${this.routeKey(binding)}:${id}`) || []) {
      this.store.retire(group,[]);this.store.setCursor(`progress-sections:${group}`,{});
    }
  }
  attachmentRoots(threadId: string) {
    return [...(this.config.attachmentRoots || [this.config.dataDir]),...(this.agent.attachmentRoots?.(threadId) || [])];
  }
  async start() {
    this.running = true;
    const builtins=builtinCommands((name,context)=>this.builtinCommand(name,context));
    const directory=resolve(this.config.dataDir,this.config.commands?.directory || 'commands');
    this.commands=[...builtins,...await loadCommandExtensions({directory,reservedNames:COMMANDS.map(c=>c.name),log:this.log})];
    this.agent.onEvent = event => this.event(event);
    await this.agent.start();
    for (const config of this.config.adapters.filter(a => a.enabled !== false)) {
      const adapter = await this.adapterFactory(config, {
        dataDir: this.config.dataDir, log: this.log,
        getCursor: key => this.store.cursor(key),
        setCursor: (key,value) => this.store.setCursor(key,value),
        commands: this.commands,
        isCommand: message => Boolean(parseCommandText(message.text,this.commands)),
        isBound: message => Boolean(parseCommandText(message.text,this.commands)) || allowed(config,message) && (
          this.config.bindings.some(b=>b.adapter===config.id && String(b.chatId)===String(message.chatId) && String(b.topicId || '')===String(message.topicId || '') && b.kind===message.kind) ||
          this.canAutoBind(config,message)),
      });
      this.adapters.set(config.id, adapter);

    }
    for (const threadId of new Set(this.config.bindings.filter(b=>this.adapters.has(b.adapter)).map(b=>b.threadId))) await this.agent.watch?.(threadId);
    for (const config of this.config.adapters.filter(a => this.adapters.has(a.id))) {
      await this.adapters.get(config.id)!.start(message => this.receive(config,message));
      this.log.info('adapter started',{id:config.id,type:config.type});
    }
    this.timer = setInterval(() => {
      this.submit().catch(e=>this.log.error('submit failed', e));
      this.flush().catch(e=>this.log.error('delivery failed',e));
    }, 1000);
    this.typingTimer = setInterval(() => this.typing(), 1000);
    await this.submit();
  }
  async receive(config: AdapterConfig, message: ChatMessage) {
    if (!allowed(config,message,{command:Boolean(parseCommandText(message.text,this.commands))})) return;
    if(await this.command(config,message))return;
    let binding;
    try { binding=await this.ensureBinding(config,message); }
    catch(error) {
      this.log.warn('chat task creation was not confirmed',{adapter:config.id,chatId:message.chatId});
      const route=this.routeKey({adapter:config.id,chatId:message.chatId,topicId:message.topicId});
      this.store.stage(stableId(route,message.id,'create-failure'),route,{text:'聊天任务创建未能确认，请在本机检查后再继续；不会自动重复创建。',target:{chatId:message.chatId,topicId:message.topicId,kind:message.kind,userId:message.userId,messageId:message.id},replyTo:message.id});
      return;
    }
    if (!binding) { this.log.warn('message ignored: chat has no explicit binding', {adapter:config.id,chatId:message.chatId}); return; }
    const admitted = this.store.admit(config.id,binding.threadId,message);
    if (admitted.fresh) {
      // Replayed platform updates retain their original durable admission and
      // must not roll the route's latest reply context back to an older message.
      this.store.setCursor(`reply:${this.routeKey(binding)}`,{messageId:message.id,userId:message.userId,topicId:message.topicId});
      // A durable admission only confirms that Rin accepted the message. Give the
      // user one prompt typing hint, but wait for the agent to confirm actual work
      // before the periodic typing loop treats the thread as active.
      this.typing(binding.threadId);
      // Admission is durable before acknowledging a platform cursor. Submission runs separately.
      queueMicrotask(()=>this.submit().catch(e=>this.log.error('submit failed',e)));
    }
  }
  canAutoBind(config: AdapterConfig,message: ChatMessage) {
    return Boolean(config.autoBind &&
      !config.autoBind.excludedChatIds?.includes(String(message.chatId)));
  }
  async ensureBinding(config: AdapterConfig,message: ChatMessage) {
    const existing=this.config.bindings.find(b=>b.adapter===config.id && String(b.chatId)===String(message.chatId) && String(b.topicId || '')===String(message.topicId || '') && b.kind===message.kind);
    if(existing || !this.canAutoBind(config,message))return existing;
    const key=this.routeKey({adapter:config.id,chatId:message.chatId,topicId:message.topicId});
    if(this.bindingCreations.has(key))return this.bindingCreations.get(key);
    const saved=this.store.cursor<AutoBindings>('auto-bindings') || {};
    if(saved[key])throw new Error('Previous task creation requires reconciliation');
    saved[key]={state:'creating'};this.store.setCursor('auto-bindings',saved);
    const pending=Promise.resolve().then(async()=>{
      try {
        let threadId;
        try {
          if(!this.agent.createThread)throw new Error('This agent adapter cannot create sessions; bind an existing session ID');
          threadId=await this.agent.createThread({cwd:(config.autoBind as Exclude<AdapterConfig['autoBind'], false | undefined>).cwd,model:(config.autoBind as Exclude<AdapterConfig['autoBind'], false | undefined>).model,name:`${config.id} · ${message.chatName || String(message.chatId)}`});
        }
        catch(error) { if(typeof failure(error).threadId==='string' && failure(error).threadId)threadId=failure(error).threadId;else throw error; }
        if(typeof threadId!=='string' || !threadId)throw new Error('Missing created task id');
        const binding={adapter:config.id,chatId:String(message.chatId),...(message.topicId ? {topicId:String(message.topicId)} : {}),kind:message.kind,threadId,mirror:true};
        validateConfig({...this.config,bindings:[...this.config.bindings,binding]});
        const current=this.store.cursor<AutoBindings>('auto-bindings') || {};current[key]={state:'bound',binding};this.store.setCursor('auto-bindings',current);
        this.config.bindings.push(binding);
        await this.agent.watch?.(threadId);
        return binding;
      } catch(error) {
        const current=this.store.cursor<AutoBindings>('auto-bindings') || {};
        if(current[key]?.state!=='bound'){current[key]={state:'uncertain'};this.store.setCursor('auto-bindings',current);}
        throw error;
      } finally { this.bindingCreations.delete(key); }
    });
    this.bindingCreations.set(key,pending);
    return pending;
  }
  async builtinCommand(name: string,{args,message}: CommandContext) {
    if(name==='help')return {text:commandHelp(this.commands,effectivePrivate(message))};
    throw new Error('Unknown built-in command');
  }
  async command(config: AdapterConfig,message: ChatMessage) {
    const parsed=parseCommandText(message.text,this.commands);
    if(!parsed)return false;
    // Reserved session controls remain silent rather than becoming agent prompts.
    if(parsed.name==='session')return true;
    if(!parsed.registered || (parsed.target && message.commandTarget!=='self'))return this.unknownCommand(config,message);
    const command=this.commands.find(c=>c.name===parsed.name)!;
    // Admission is the only caller permission check. Claim before every handler.
    const key=`command:${message.topicId ? stableId(config.id,message.chatId,message.topicId,message.id) : stableId(config.id,message.chatId,message.id)}`;
    if(this.store.cursor(key))return true;
    this.store.setCursor(key,{state:'started'});
    let output;
    try {
      if(command.privateOnly && !effectivePrivate(message))output={text:'请在私聊中使用此命令。'};
      else {
        const result=await command.run({args:parsed.args,message:{adapter:config.id,id:message.id,chatId:message.chatId,...(message.topicId?{topicId:message.topicId}:{}),userId:message.userId,kind:message.kind,text:message.text,...(message.privateLike?{privateLike:true}:{})},dataDir:this.config.dataDir});
        if(result != null && (typeof result!=='object' || Array.isArray(result) || (result.text!==undefined && typeof result.text!=='string') ||
          (result.fallbackText!==undefined && typeof result.fallbackText!=='string') ||
          (result.files!==undefined && (!Array.isArray(result.files) || result.files.some(file=>!file || typeof file.path!=='string' || (file.name!==undefined && typeof file.name!=='string') || (file.mimeType!==undefined && typeof file.mimeType!=='string')))) ||
          (result.fallbackText && !result.text && !result.files?.length)))throw new Error('Invalid command result');
        output={text:result?.text || '',...(result?.fallbackText?{fallbackText:result.fallbackText}:{}),...(result?.files?.length?{files:result.files.map(({path,name,mimeType})=>({path,...(name?{name}:{}),...(mimeType?{mimeType}:{})}))}:{})};
      }
    } catch {
      this.log.warn('command failed',{name:command.name});
      output={text:'命令未完成，请检查输入或稍后重试。'};
    }
    const target={chatId:message.chatId,...(message.topicId?{topicId:message.topicId}:{}),kind:message.kind,userId:message.userId,messageId:message.id,
      ...(message.commandInteraction?{commandInteraction:{id:message.commandInteraction.id}}:{})};
    const chunks=['discord','telegram'].includes(config.type)
      ? prepareText(config.type,output.text || '',this.adapters.get(config.id)?.capabilities.maxText || 1900)
      : splitText(stripMarkdownFormatting(output.text || ''),1900).map(text=>({text}));
    // Native interaction replies are one private response; adapters retain the handle in memory.
    const hasOutput=Boolean(output.text || output.files?.length);
    const parts=!hasOutput ? (message.commandInteraction ? [{delete:true}] : []) : message.commandInteraction?[{text:output.text,...(output.fallbackText?{fallbackText:output.fallbackText}:{}),...(output.files?.length?{files:output.files}:{})}]
      : [...chunks,...(output.files?.length?[{files:output.files,...(output.fallbackText?{fallbackText:output.fallbackText}:{})}]:[])];
    for(const [index,part] of parts.entries())this.store.stage(stableId(key,index),this.routeKey({adapter:config.id,chatId:message.chatId,topicId:message.topicId}),{
      ...part,...(!message.commandInteraction && index===0?{replyTo:message.id}:{}),target});
    this.store.setCursor(key,{state:'done'});
    if(message.commandInteraction)await this.flush();
    return true;
  }
  unknownCommand(config: AdapterConfig,message: ChatMessage) {
    if(!effectivePrivate(message))return true;
    const key=`unknown-command:${message.topicId ? stableId(config.id,message.chatId,message.topicId,message.id) : stableId(config.id,message.chatId,message.id)}`;
    if(this.store.cursor(key))return true;
    this.store.setCursor(key,{state:'started'});
    this.store.stage(stableId(key,0),this.routeKey({adapter:config.id,chatId:message.chatId,topicId:message.topicId}),{
      text:'Unknown command. Send /help to see available commands.',replyTo:message.id,
      target:{chatId:message.chatId,...(message.topicId?{topicId:message.topicId}:{}),kind:message.kind,userId:message.userId,messageId:message.id},
    });
    this.store.setCursor(key,{state:'done'});
    return true;
  }

  async submit() {
    if (!this.running) return;
    const threads=[...new Set(this.store.pending().map(job=>job.thread))].filter(thread=>!this.submittingThreads.has(thread) && !this.faultedThreads.has(thread));
    await Promise.all(threads.map(thread=>this.submitThread(thread)));
  }
  async submitThread(thread: string) {
    if(this.submittingThreads.has(thread) || !this.running)return;
    this.submittingThreads.add(thread);
    try {
      while(this.running) {
        const job=this.store.pending().find(candidate=>candidate.thread===thread);
        if(!job || this.faultedThreads.has(job.thread))break;
        this.store.inboxState(job.id,'submitting');
        const message = JSON.parse(job.payload) as ChatMessage;
        const [ingressAdapterId] = JSON.parse(job.id) as [string];
        try {
          // A start event can be observed before its server receipt. Freeze the
          // submitting chat's reply context now; later ingress must not make
          // that new physical turn look as though it belonged to a newer chat.
          const routedBindings=this.config.bindings.filter(b=>b.threadId===job.thread && b.mirror===true && this.adapters.has(b.adapter));
          for(const binding of routedBindings)this.store.setCursor(this.inflightInputKey(binding,job.thread),{jobId:job.id,context:this.inboundContext(binding,ingressAdapterId,message)});
          const receipt = await this.agent.queue(job.thread,{text:composeInboundText(message.text,{reply:this.store.replyContext(ingressAdapterId,message),forward:message.forward}),files:message.files || [],onClientMessageId:id=>{
            for(const binding of this.config.bindings.filter(b=>b.threadId===job.thread && b.mirror===true && this.adapters.has(b.adapter)))this.expectInput(binding,id);
          }});
          const accepted=Boolean(receipt?.turnId);
          const state=accepted ? 'delivered' : 'queued';
          this.store.inboxState(job.id,state,typeof receipt === 'string' ? receipt : JSON.stringify(receipt));
          if(accepted) {
            if(receipt.turnId) for(const binding of this.config.bindings.filter(b=>b.threadId===job.thread && b.mirror===true && this.adapters.has(b.adapter))) {
              const [adapterId]=JSON.parse(job.id);
              const context=this.inboundContext(binding,adapterId,message);
              const presentation=this.activatePresentation(binding,job.id,receipt.turnId,context,receipt.messageId);
              this.store.setCursor(this.inflightInputKey(binding,job.thread),false);
              const terminal=this.physicalTerminal(job.thread,receipt.turnId);
              if(terminal) {
                if(terminal.type==='failed')this.stageFailure(binding,presentation);
                continue;
              }
              this.active.add(job.thread);
              if(this.adapters.get(binding.adapter)!.capabilities.edit) {
                this.stageText(binding,{threadId:job.thread,turnId:receipt.turnId,itemId:'progress',phase:'working',text:workingFrame(this.working),presentationId:presentation.id},false);
                this.startWorkingRotation(binding,job.thread,receipt.turnId,presentation.id);
              } else if(this.adapters.get(binding.adapter)!.capabilities.reaction) this.beginReaction(binding,presentation).catch(error=>this.log.warn('working reaction failed',error));
              else this.stageWorkingMarker(binding,receipt.turnId,context,presentation.id);
            }
          }
          for(const binding of routedBindings)this.store.setCursor(this.inflightInputKey(binding,job.thread),false);
          this.log.info('message submitted', {threadId:job.thread,transport:receipt?.transport || 'native-queue'});
        } catch (error) {
          for(const binding of this.config.bindings.filter(b=>b.threadId===job.thread && b.mirror===true && this.adapters.has(b.adapter)))this.store.setCursor(this.inflightInputKey(binding,job.thread),false);
          // A lost CLI response may follow a successful submission. Do not replay it automatically.
          this.store.inboxState(job.id,'uncertain',null,'Agent submission failed; inspect redacted service log');
          const [adapterId] = JSON.parse(job.id);
          const binding=this.config.bindings.find(b=>b.adapter===adapterId && String(b.chatId)===String(message.chatId) && String(b.topicId || '')===String(message.topicId || '') && b.kind===message.kind);
          if(binding) {
            const text=error instanceof Error ? error.message : String(error);
            this.store.stage(stableId('submission-error',job.id),this.routeKey(binding),{
              text,replyTo:message.id,
              target:{chatId:message.chatId,...(message.topicId?{topicId:message.topicId}:{}),kind:message.kind,userId:message.userId,messageId:message.id},
            });
          }
          this.log.error('message submission uncertain; inspect before retry',error);
        }
      }
    } finally {
      this.submittingThreads.delete(thread);
      // An ingress can land after this worker's final pending() read. Recheck
      // immediately instead of leaving that route to the one-second timer.
      if(this.running && !this.faultedThreads.has(thread) && this.store.pending().some(job=>job.thread===thread)) queueMicrotask(()=>this.submit().catch(error=>this.log.error('submit failed',error)));
    }
  }
  event(event: AgentEvent) {
    if (!event.threadId) return;
    if(event.type==='observerError') {
      this.log.error('Agent observer stopped',event.error || event.text || 'unsupported history');
      this.stopWorkingRotation(event.threadId);
      for(const binding of this.config.bindings.filter(b=>b.threadId===event.threadId && this.adapters.has(b.adapter))) for(const presentation of Object.values(this.presentations(binding).entries)) this.endReaction(binding,presentation.id).catch(error=>this.log.warn('working reaction cleanup failed',error));
      this.active.delete(event.threadId);this.faultedThreads.add(event.threadId);return;
    }
    const bindings = this.config.bindings.filter(b=>b.threadId===event.threadId && this.adapters.has(b.adapter) && b.mirror === true);
    if (!bindings.length) return;
    if(event.type==='input') {
      const ordinal=event.ordinal;
      if(ordinal===undefined || !Number.isFinite(ordinal))return;
      for(const binding of bindings) {
        if(!event.clientMessageId)continue;
        const state=this.presentations(binding);
        const matched=Object.values(state.entries).some(presentation=>presentation.turnId===event.turnId && presentation.inputId===event.clientMessageId);
        if(!matched && !this.expectsInput(binding,event.clientMessageId))continue;
        const inputs=this.inputBoundaries(binding,event.threadId,event.turnId);
        inputs[event.clientMessageId]=ordinal;this.saveInputBoundaries(binding,event.threadId,event.turnId,inputs);
        for(const presentation of Object.values(state.entries)) if(presentation.turnId===event.turnId && presentation.inputId===event.clientMessageId && presentation.boundary===undefined) {
          presentation.boundary=ordinal;this.savePresentations(binding,state);
          this.deliverDeferred(binding,presentation);
        }
      }
      return;
    }
    if (event.type === 'image' && event.itemId && event.turnId && typeof event.path === 'string') {
      // Only the App's completed image artifact for this task is eligible;
      // generic tool outputs and artifacts belonging to other tasks stay private.
      const files=outputFiles(`[image](${encodeURIComponent(event.path)})`,this.attachmentRoots(event.threadId)).filter(file=>file.mimeType?.startsWith('image/'));
      if (!files.length) { this.log.error('Generated image cannot be delivered: missing file or invalid task artifact path'); return; }
      for (const binding of bindings) this.stageImage(binding,event);
      return;
    }
    if (event.type === 'started') {
      this.active.add(event.threadId);
      this.typing(event.threadId);
      for(const binding of bindings) {
        const key=`turn-reply:${this.routeKey(binding)}:${event.turnId}`;
        const inflight=this.store.cursor<{jobId: string; context: Partial<ChatTarget>}>(this.inflightInputKey(binding,event.threadId));
        if(this.store.cursor(key)===undefined)this.store.setCursor(key,inflight?.context || this.store.cursor<Partial<ChatTarget>>(`reply:${this.routeKey(binding)}`) || {});
        const presentation=this.presentationFor(binding,{threadId:event.threadId,turnId:event.turnId,itemId:'progress',phase:'working',text:''});
        if(!presentation)continue;
        const state=this.presentations(binding), current=state.currentId ? state.entries[state.currentId] : undefined;
        if(current?.turnId!==event.turnId) {state.currentId=presentation.id;this.savePresentations(binding,state);}
        if(this.adapters.get(binding.adapter)!.capabilities.edit) {
          this.stageText(binding,{threadId:event.threadId,turnId:event.turnId,itemId:'progress',phase:'working',text:workingFrame(this.working),presentationId:presentation.id},false);
          this.startWorkingRotation(binding,event.threadId,event.turnId,presentation.id);
        }
        else if(this.adapters.get(binding.adapter)!.capabilities.reaction) this.beginReaction(binding,presentation).catch(error=>this.log.warn('working reaction failed',error));
        else this.stageWorkingMarker(binding,event.turnId,presentation.context,presentation.id);
      }
    }
    if (event.type === 'text') {
      if(event.phase==='question') {
        if(event.text && event.itemId) {
          const key=JSON.stringify([event.threadId,event.turnId,event.itemId]);
          const item: PublicItem={threadId:event.threadId,turnId:event.turnId,itemId:event.itemId,phase:'question',text:event.text,ordinal:event.ordinal};
          this.items.set(key,item);this.store.setCursor('public-items',[...this.items]);
          for(const binding of bindings)this.stageText(binding,item,true);
        }
        return;
      }
      if(!event.phase)event={...event,phase:'final'};
      if(event.phase==='summary' || event.phase==='reasoning_summary')event={...event,text:normalizeAssistantSummaryText(event.text)};
      if(event.phase==='final_answer') event={...event,phase:'final'};
      if(event.phase==='reasoning_summary') event={...event,phase:'summary'};
      if (!['commentary','final','summary'].includes(event.phase || 'final')) return;
      if (event.phase==='summary' && this.config.display?.summaries === false) return;
      if(event.phase==='summary' && !event.text)return;
      const itemId = event.itemId || event.turnId;
      if (!itemId) return;
      const key = JSON.stringify([event.threadId,event.turnId,itemId]);
      const old = this.items.get(key) || {text:'',phase:event.phase || 'final',turnId:event.turnId,threadId:event.threadId,itemId,ordinal:event.ordinal};
      old.phase = event.phase || 'final';
      old.text = event.delta !== undefined ? old.text+event.delta : (event.text ?? old.text);
      // A subsequent public item closes the preceding message on transports without edits.
      if(!this.items.has(key)) for(const previous of this.items.values()) {
        if(previous.threadId===event.threadId && previous.turnId===event.turnId)
          for(const binding of bindings) if(!this.adapters.get(binding.adapter)!.capabilities.edit) this.stageText(binding,previous,true);
      }
      this.items.set(key,old);
      this.store.setCursor('public-items',[...this.items]);
      for (const binding of bindings) this.stageText(binding,old,event.done === true || event.delta === undefined);
    }
    if (event.type === 'completed' || event.type === 'failed') {
      this.store.setCursor(this.physicalTerminalKey(event.threadId,event.turnId),{type:event.type});
      const current=bindings.some(binding=>this.currentPresentation(binding)?.turnId===event.turnId);
      if(current)this.stopWorkingRotation(event.threadId,event.turnId);
      for(const binding of bindings) {
        const presentation=this.currentPresentation(binding);
        if(presentation?.turnId===event.turnId)this.endReaction(binding,presentation.id).catch(error=>this.log.warn('working reaction cleanup failed',error));
      }
      for (const [key,item] of this.items) {
        if (item.threadId !== event.threadId || (event.turnId && item.turnId !== event.turnId)) continue;
        for (const binding of bindings) this.stageText(binding,item,true);
      }
      for(const [key,item] of this.items) if(item.threadId===event.threadId && (!event.turnId || item.turnId===event.turnId) &&
        bindings.every(binding=>this.store.cursor(this.presentationItemKey(binding,item))!==undefined))this.items.delete(key);
      if (event.type === 'failed') for (const binding of bindings) {
        // The physical turn may have failed after accepting an input whose server
        // receipt has not arrived. Let that receipt choose the failure's owner.
        if(this.store.cursor(this.inflightInputKey(binding,event.threadId)))continue;
        const presentation=this.currentPresentation(binding)?.turnId===event.turnId ? this.currentPresentation(binding) : this.presentationFor(binding,{threadId:event.threadId,turnId:event.turnId,itemId:'failure',phase:'final',text:'',ordinal:undefined});
        if(presentation)this.stageFailure(binding,presentation);
      }
      this.store.setCursor('public-items',[...this.items]);
      if(current)this.active.delete(event.threadId);
    }
  }
  stageFailure(binding: Binding, presentation: Presentation) {
    const context=presentation.context;
    this.store.stage(stableId(this.routeKey(binding),presentation.id,'failure'),this.routeKey(binding),{
      text:'本轮执行未完成，请在所用 agent 中查看错误后继续。',...(context.messageId?{replyTo:context.messageId}:{}),
      target:{chatId:binding.chatId,...(binding.topicId?{topicId:binding.topicId}:{}),kind:binding.kind,...context},
    });
  }
  stageImage(binding: Binding,event: Pick<AgentEvent,'threadId'|'turnId'|'itemId'|'path'|'ordinal'>) {
    if(!event.itemId || !event.turnId || typeof event.path!=='string')return;
    const files=outputFiles(`[image](${encodeURIComponent(event.path)})`,this.attachmentRoots(event.threadId)).filter(file=>file.mimeType?.startsWith('image/'));
    if(!files.length) { this.log.error('Generated image cannot be delivered: missing file or invalid task artifact path'); return; }
    const presentation=this.presentationFor(binding,{threadId:event.threadId,turnId:event.turnId,itemId:event.itemId,phase:'image',text:'',ordinal:event.ordinal});
    if(!presentation) {
      const images=this.deferredImages(binding,event.threadId,event.turnId);images[event.itemId]={itemId:event.itemId,path:event.path,ordinal:event.ordinal};this.saveDeferredImages(binding,event.threadId,event.turnId,images);return;
    }
    const context=presentation.context;
    this.store.stage(stableId(this.routeKey(binding),presentation.id,event.itemId,'generated-image'),this.routeKey(binding),{
      files,...(context.messageId?{replyTo:context.messageId}:{}),target:{chatId:binding.chatId,...(binding.topicId?{topicId:binding.topicId}:{}),kind:binding.kind,...context},
    });
    const images=this.deferredImages(binding,event.threadId,event.turnId);if(images[event.itemId]) {images[event.itemId].delivered=true;this.saveDeferredImages(binding,event.threadId,event.turnId,images);}
  }
  stageWorkingMarker(binding: Binding,turnId: string,context: Partial<ChatTarget>,presentationId=`turn:${turnId}`, force=false) {
    if(quietFor(this.config,binding))return;
    const adapter=this.adapters.get(binding.adapter);
    if(!adapter || adapter.capabilities.edit || (adapter.capabilities.reaction && !force)) return;
    if(this.presentationFinalized(binding,presentationId))return;
    const route=this.routeKey(binding);
    const scope=presentationId.startsWith('turn:') ? turnId : presentationId;
    this.store.stage(stableId(route,scope,context.messageId || 'chat','working-marker'),route,{
      text:workingFrame(this.working),
      ...(context.messageId?{replyTo:context.messageId}:{}),
      target:{chatId:binding.chatId,kind:binding.kind,...context},
    });
  }

  stageText(binding: Binding,item: PublicItem,done: boolean) {
    if(quietFor(this.config,binding) && !['final','error'].includes(item.phase))return;
    const adapter = this.adapters.get(binding.adapter)!;
    if (!adapter.capabilities.edit && !done) return;
    const type=this.config.adapters.find(a=>a.id===binding.adapter)?.type || '';
    const presentation=item.presentationId ? this.presentationById(binding,item.presentationId) : this.presentationFor(binding,item);
    if(!presentation)return;
    if(item.phase!=='final' && this.presentationFinalized(binding,presentation.id))return;
    if(item.phase==='final') {
      this.finalizePresentation(binding,presentation.id);
      this.stopWorkingRotation(item.threadId,item.turnId,presentation.id);
      this.endReaction(binding,presentation.id).catch(error=>this.log.warn('working reaction cleanup failed',error));
    }
    const replyContext=presentation.context;
    const replyTo=replyContext.messageId;
    const targetContext={};
    const progressScope=type==='telegram' ? 'chat' : (replyTo ? `quote:${replyTo}` : 'chat');
    const presentationScope=presentation.id.startsWith('turn:') ? item.turnId : presentation.id;
    const baseProgressGroup=stableId(this.routeKey(binding),'progress',...(presentation.id.startsWith('turn:') ? [progressScope] : [presentationScope,progressScope]));
    const segmentKey=`progress-segments:${this.routeKey(binding)}:${presentationScope}`;
    const segments=this.store.cursor<Segments>(segmentKey) || {current:0,questions:[],items:{},groups:[]};
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
        this.store.setCursor(`progress-sections:${progressGroup}`,{});
      } else {
        const itemSegment=segments.items[item.itemId];
        // Working frames always belong to the current progress segment. Public
        // items retain their original segment when history is replayed.
        if(item.phase!=='working' && itemSegment!==undefined && itemSegment!==segments.current)return;
        if(item.phase!=='working')segments.items[item.itemId]=segments.current;
        if(!segments.groups.includes(progressGroup))segments.groups.push(progressGroup);
        this.store.setCursor(segmentKey,segments);
        const presentationGroups=this.store.cursor<string[]>(`presentation-progress-groups:${this.routeKey(binding)}:${presentation.id}`) || [];
        if(!presentationGroups.includes(progressGroup))this.store.setCursor(`presentation-progress-groups:${this.routeKey(binding)}:${presentation.id}`,[...presentationGroups,progressGroup]);
        const sections=this.store.cursor<Record<string,string>>(`progress-sections:${progressGroup}`) || {};
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
      const group=stableId(this.routeKey(binding),presentationScope,item.itemId,...(!adapter.capabilities.edit ? [item.text] : []));
      const liveIds=[];
      let first=true;
      const parts=outputParts(item.text,this.attachmentRoots(item.threadId));
      for(const [index,part] of parts.entries()) {
        if(part.text && !adapter.capabilities.edit && !['final','question'].includes(item.phase))part.text=editableIntermediateHeadText(part.text);
        if(part.text && type==='onebot')part.text=stripMarkdownFormatting(part.text);
        const outputs: ChatOutput[]=part.files ? [part] : ['discord','telegram'].includes(type)
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
    const group=progress ? progressGroup : stableId(this.routeKey(binding),presentationScope,item.itemId);
    const liveIds=[];
    for (let i=0;i<chunks.length;i++) {
      const id=progress ? stableId(group,i) : stableId(this.routeKey(binding),presentationScope,item.itemId,i);liveIds.push(id);
      this.store.stage(id,this.routeKey(binding),{...chunks[i],...targetContext,...(progress?{progress:true}:{}),...(i===0 && replyTo ? {replyTo} : {})},group);
    }
    if(typeof adapter.delete==='function')this.store.retire(group,liveIds);
    if(done) for(const file of outputFiles(item.text,this.attachmentRoots(item.threadId))) {
      this.store.stage(stableId(this.routeKey(binding),presentationScope,item.itemId,'file',file.path),this.routeKey(binding),{
        files:[file],...(replyTo?{replyTo}:{}),target:{chatId:binding.chatId,...(binding.topicId?{topicId:binding.topicId}:{}),kind:binding.kind,...replyContext},
      });
    }
  }
  startWorkingRotation(binding: Binding,threadId: string,turnId: string,presentationId=`turn:${turnId}`) {
    if(quietFor(this.config,binding))return;
    const key=JSON.stringify([this.routeKey(binding),presentationId]);
    if(this.workingTimers.has(key) || this.working.frames.length<2)return;
    let index=0;
    const timer=setInterval(()=>{
      if(!this.running || !this.active.has(threadId) || this.presentationFinalized(binding,presentationId))return this.stopWorkingRotation(threadId,turnId,presentationId);
      index=(index+1)%this.working.frames.length;
      this.stageText(binding,{threadId,turnId,itemId:'progress',phase:'working',text:workingFrame(this.working,index),presentationId},false);
      this.flush().catch(error=>this.log.error('working status delivery failed',error));
    },this.working.intervalMs);
    timer.unref?.();
    this.workingTimers.set(key,{timer,threadId,turnId,presentationId});
  }
  stopWorkingRotation(threadId: string,turnId?: string,presentationId?: string) {
    for(const [key,state] of this.workingTimers) {
      if(state.threadId!==threadId || (turnId && state.turnId!==turnId))continue;
      if(presentationId && state.presentationId!==presentationId)continue;
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
        const payload = JSON.parse(item.payload) as ChatOutput;
        const route = this.route(item.route) || (payload.target && {...payload.target,adapter:JSON.parse(item.route)[0]}); const adapter = this.adapters.get(route?.adapter || '');
        if (!adapter || !route) continue;
        this.store.sending(item.id);
        const target = {...route,...this.store.cursor<Partial<ChatTarget>>(`reply:${item.route}`),...(payload.replyTo ? {messageId:payload.replyTo} : {}),...payload.target};
        try {
          if(payload.delete) {const deleteId=item.message_id || target.commandInteraction?.id;if(deleteId)await adapter.delete?.(target,deleteId);this.store.sent(item.id,item.payload,null);continue;}
          const sent = await adapter.send(target,{...payload,...(item.message_id && adapter.capabilities.edit ? {editId:item.message_id} : {})});
          this.store.sent(item.id,item.payload,sent.id);
          this.retryAt.delete(item.id);
          if(payload.progress && route && 'threadId' in route && typeof route.threadId === 'string')this.typing(route.threadId);
        } catch (error) {
          if(payload.files?.length && payload.fallbackText && failure(error)?.fallbackSafe===true) {
            try {
              const fallback=await adapter.send(target,{text:payload.fallbackText,...(payload.replyTo?{replyTo:payload.replyTo}:{})});
              this.store.sent(item.id,item.payload,fallback.id);this.retryAt.delete(item.id);continue;
            } catch(fallbackError) { error=fallbackError; }
          }
          // Editing an identified message is safe to retry; a first send with unknown outcome isn't.
          this.store.failed(item.id,'Platform delivery failed; inspect redacted service log',Boolean(item.message_id) && failure(error)?.deliveryUncertain !== true);
          const delay=Math.min(30000,(this.retryAt.get(item.id)?.delay || 500)*2);
          this.retryAt.set(item.id,{delay,at:Date.now()+delay});
          this.log.error('outbound delivery failed',error);
        }
      }
    } finally { this.flushing = false; }
  }
  typing(threadId?: string) {
    for (const b of this.config.bindings) {
      if (threadId ? b.threadId !== threadId : !this.active.has(b.threadId)) continue;
      if(quietFor(this.config,b))continue;
      const a = this.adapters.get(b.adapter);
      const config=this.config.adapters.find(a=>a.id===b.adapter);
      const now=Date.now();
      const interval=config?.type==='telegram'?4000:config?.type==='discord'?9000:30000;
      if(!threadId && now-(this.lastTypingAt.get(this.routeKey(b)) || 0)<interval)continue;
      this.lastTypingAt.set(this.routeKey(b),now);
      if (a?.capabilities.typing) a.typing({...b,...this.store.cursor<Partial<ChatTarget>>(`reply:${this.routeKey(b)}`)}).catch(e=>this.log.warn('typing failed',e));
    }
  }
  async stop() {
    this.running = false; clearInterval(this.timer); clearInterval(this.typingTimer);
    for(const {timer} of this.workingTimers.values())clearInterval(timer);
    this.workingTimers.clear();
    await Promise.allSettled(this.config.bindings.filter(binding=>this.adapters.has(binding.adapter)).flatMap(binding=>Object.keys(this.presentations(binding).entries).map(id=>this.endReaction(binding,id))));
    await Promise.allSettled([...this.adapters.values()].map(a=>a.stop()));
    await this.agent.stop();
    const deadline = Date.now()+15000;
    while ((this.flushing || this.submittingThreads.size || this.bindingCreations.size) && Date.now()<deadline) await new Promise(r=>setTimeout(r,50));
    if (!this.flushing && !this.submittingThreads.size && !this.bindingCreations.size) this.store.close();
  }
}
