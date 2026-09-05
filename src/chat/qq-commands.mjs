import {COMMANDS} from './commands.mjs';

export const QQ_COMMAND_PANEL_REMARK = 'Rin commands';

function definitions(commands) {
  if (Array.isArray(commands)) return commands;
  return COMMANDS;
}

function items(commands) {
  return commands.map(({name, description}) => ({
    type: 'command', name: `/${name}`, desc: Array.from(String(description || '')).slice(0, 30).join(''),
  }));
}

export function qqCommandPanels(commands) {
  const all = definitions(commands);
  return [
    {scope: 'c2c', target_type: 'all', panel: {items: items(all), remark: QQ_COMMAND_PANEL_REMARK}},
    {scope: 'group', target_type: 'all', panel: {items: items(all.filter(command => command.privateOnly !== true)), remark: QQ_COMMAND_PANEL_REMARK}},
  ];
}

function comparableItems(items) {
  return (items || []).map(item=>[item.type,String(item.name || '').replace(/^\//,''),item.desc || '',Boolean(item.only_admin)]);
}

function samePanel(record, desired) {
  return record?.target_type === desired.target_type &&
    record?.panel?.remark === desired.panel.remark &&
    JSON.stringify(comparableItems(record.panel.items)) === JSON.stringify(comparableItems(desired.panel.items));
}

function apiCode(error) {
  const value = error?.bizCode ?? error?.httpStatus ?? error?.code ?? error?.status ?? error?.response?.status;
  return Number.isInteger(Number(value)) ? String(Number(value)) : 'unknown';
}

async function removeCommands(request, apiClient, token, scope, record) {
  const commandItems = (record?.panel?.items || []).filter(item => item?.type === 'command');
  if (!commandItems.length) return;
  if (!record?.panel_id) throw new Error(`qq_command_panel_cleanup_failed:${scope}:missing_id:unknown`);
  const path = `/v2/panels/${encodeURIComponent(String(record.panel_id))}`;
  const remaining = record.panel.items.filter(item => item?.type !== 'command');
  try {
    if (!remaining.length) await request.call(apiClient, token, 'DELETE', path);
    else await request.call(apiClient, token, 'PUT', path, {panel: {...record.panel, items: remaining}});
  } catch (error) {
    throw new Error(`qq_command_panel_cleanup_failed:${scope}:${remaining.length ? 'update' : 'delete'}:${apiCode(error)}`);
  }
}

async function deletePanel(request, apiClient, token, scope, record) {
  if (!record?.panel_id) throw new Error(`qq_command_panel_cleanup_failed:${scope}:missing_id:unknown`);
  try {
    await request.call(apiClient, token, 'DELETE', `/v2/panels/${encodeURIComponent(String(record.panel_id))}`);
  } catch (error) {
    throw new Error(`qq_command_panel_cleanup_failed:${scope}:delete:${apiCode(error)}`);
  }
}

export async function syncQQCommandPanels(bot, config, commands) {
  const getToken = bot?.tokenManager?.getAccessToken;
  const request = bot?.apiClient?.request;
  if (typeof getToken !== 'function' || typeof request !== 'function') throw new Error('qq_command_panel_api_missing');
  let token;
  try { token = await getToken.call(bot.tokenManager, config.appId, config.appSecret); }
  catch (error) { throw new Error(`qq_command_panel_sync_failed:token:access:${apiCode(error)}`); }
  const failures = [];
  const desiredByScope = new Map(qqCommandPanels(commands).map(panel => [panel.scope, panel]));
  for (const scope of ['c2c','group','channel','dm']) {
    const desired = desiredByScope.get(scope);
    let page;
    try { page = await request.call(bot.apiClient, token, 'GET', `/v2/panels?scope=${scope}&limit=50`); }
    catch (error) { failures.push(`${scope}:list:${apiCode(error)}`); continue; }
    if(page?.records===undefined && page?.is_end===true)page={...page,records:[]};
    if(!Array.isArray(page?.records) || page.is_end === false){failures.push(`${scope}:list_incomplete:unknown`);continue;}
    const owned = page.records.filter(record => record?.panel?.remark === QQ_COMMAND_PANEL_REMARK && record?.panel_id);
    const retained = desired ? owned[0] : undefined;
    for (const record of page.records) {
      if (record === retained) continue;
      try {
        if (owned.includes(record)) await deletePanel(request, bot.apiClient, token, scope, record);
        else await removeCommands(request, bot.apiClient, token, scope, record);
      } catch (error) {
        failures.push(/^qq_command_panel_cleanup_failed:[a-z0-9_]+:[a-z_]+:(?:\d+|unknown)$/.test(error.message)
          ? error.message.slice('qq_command_panel_cleanup_failed:'.length) : `${scope}:cleanup:unknown`);
      }
    }
    if (!desired) continue;
    if (!retained) {
      try { await request.call(bot.apiClient, token, 'POST', '/v2/panels', desired); }
      catch (error) { failures.push(`${scope}:create:${apiCode(error)}`); }
    } else if (retained.target_type!==desired.target_type) {
      failures.push(`${scope}:owner_scope_conflict:unknown`);
    } else if (!samePanel(retained, desired)) {
      try { await request.call(bot.apiClient, token, 'PUT', `/v2/panels/${encodeURIComponent(String(retained.panel_id))}`, {panel: desired.panel}); }
      catch (error) { failures.push(`${scope}:update:${apiCode(error)}`); }
    }
  }
  if (failures.length) throw new Error(`qq_command_panel_sync_failed:${failures.join(',')}`);
}
