import {COMMANDS} from './commands.mjs';

export const QQ_COMMAND_PANEL_REMARK = 'Rin commands';

const descriptions = Object.freeze({
  help: '查看可用命令', usage: '私聊查看账户用量', bind: '连接已有任务',
  status: '查看连接状态', unbind: '解除连接',
});

function items(names) {
  return names.map(name => {
    if (!COMMANDS.some(command => command.name === name)) throw new Error(`unknown_qq_command:${name}`);
    return {type: 'command', name: `/${name}`, desc: descriptions[name]};
  });
}

export function qqCommandPanels() {
  return [
    {scope: 'c2c', target_type: 'all', panel: {items: items(['help','usage','bind','status','unbind']), remark: QQ_COMMAND_PANEL_REMARK}},
    {scope: 'group', target_type: 'all', panel: {items: items(['help','status']), remark: QQ_COMMAND_PANEL_REMARK}},
  ];
}

function samePanel(record, desired) {
  return record?.target_type === desired.target_type &&
    record?.panel?.remark === desired.panel.remark &&
    JSON.stringify(record.panel.items || []) === JSON.stringify(desired.panel.items);
}

export async function syncQQCommandPanels(bot, config) {
  const getToken = bot?.tokenManager?.getAccessToken;
  const request = bot?.apiClient?.request;
  if (typeof getToken !== 'function' || typeof request !== 'function') throw new Error('qq_command_panel_api_missing');
  const token = await getToken.call(bot.tokenManager, config.appId, config.appSecret);
  for (const desired of qqCommandPanels()) {
    const page = await request.call(bot.apiClient, token, 'GET', `/v2/panels?scope=${desired.scope}&limit=50`);
    if(!Array.isArray(page?.records) || page.is_end === false)throw new Error('qq_command_panel_list_incomplete');
    const owned = page.records.filter(record => record?.panel?.remark === QQ_COMMAND_PANEL_REMARK);
    if (owned.length > 1) throw new Error(`qq_command_panel_ambiguous:${desired.scope}`);
    if (!owned.length) {
      await request.call(bot.apiClient, token, 'POST', '/v2/panels', desired);
    } else if (!owned[0].panel_id || owned[0].target_type!==desired.target_type) {
      throw new Error('qq_command_panel_owner_scope_conflict');
    } else if (!samePanel(owned[0], desired)) {
      await request.call(bot.apiClient, token, 'PUT', `/v2/panels/${encodeURIComponent(String(owned[0].panel_id))}`, {panel: desired.panel});
    }
  }
}
