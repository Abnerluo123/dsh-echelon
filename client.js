/**
 * dsh-echelon — browser half.
 *
 * Contributes one settings section (`settings.section` id `model-router`) that
 * edits the router's own settings document over the plugin's same-origin API:
 *
 *   - tiers: create, rename, reorder, enable/disable, delete;
 *   - members: pick a real model out of the live catalog, order them, and give
 *     each its own retry budget and idle timeout;
 *   - exposure: show tiers only, show everything, or hide a chosen list;
 *   - a live preview of what the model picker will look like.
 *
 * Written as a hand-authored ModuleLoader bundle: no build step, and the only
 * dependency is the `react` the shell already provides. The document is the
 * single source of truth — the page edits a draft, then saves the whole thing,
 * which is what makes a reorder an atomic operation instead of a sequence of
 * writes that can fail halfway.
 */
window.__ModuleLoader__.load({
  id: 'dsh-echelon',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, Fragment, useCallback, useEffect, useMemo, useRef, useState } = React

    const API = '/api/model-router'
    const ROUTER_PROVIDER = 'model-router'

    // ── copy ────────────────────────────────────────────────────────────────
    // Both languages live here rather than in `locale/*.json` because the page
    // needs them at render time and the section label must resolve before the
    // dictionaries are registered.
    const DICT = {
      zh: {
        nav: 'Echelon',
        title: 'Echelon',
        loading: '正在读取…',
        loadFailed: '无法连接插件后端',
        retry: '重试',
        save: '保存',
        reload: '重新加载',
        saving: '正在保存…',
        saved: '已保存。',
        saveFailed: '保存失败',
        unsaved: '有未保存的修改',

        'tiers.title': '挡位',
        'tiers.hint': '顺序即模型选择器里的顺序。',
        'tiers.add': '新增挡位',
        'tiers.name': '名称',
        'tiers.namePlaceholder': '例如：日常 / 攻坚 / 便宜',
        'tiers.enabled': '启用',
        'tiers.disabled': '已停用',
        'tiers.up': '上移',
        'tiers.down': '下移',
        'tiers.remove': '删除',
        'tiers.removeConfirm': '删除挡位「{name}」？成员配置会一并删除。',
        'tiers.empty': '还没有挡位。新增一个，然后往里加模型。',
        'tiers.defaults': '挡位默认值',
        'tiers.inherit': '跟随成员',
        'tiers.useGlobal': '全局默认',
        'tiers.members': '成员（按顺序）',
        'tiers.membersEmpty': '还没有模型。选一个加进来。',
        'tiers.addMember': '添加模型',
        'tiers.maxTiers': '最多 {n} 个挡位',

        'member.provider': '来源',
        'member.model': '模型',
        'member.attempts': '重试次数',
        'member.timeout': '超时',
        'member.timeoutUnit': '秒',
        'member.unlimited': '不限制',
        'member.follow': '跟随挡位',
        'member.effort': '思考强度',
        'member.effortDefault': '跟随会话',
        'member.effortOff': '关闭思考',
        'member.effortHint': '',
        'member.effortStale': '模型没上报',
        'member.context': '上下文长度',
        'member.maxTokens': '最大输出',
        'member.defaultAuto': '模型默认',
        'member.enabled': '启用',
        'member.remove': '移除',
        'member.up': '上移',
        'member.down': '下移',
        'member.missing': '该模型已不在目录中',
        'member.vision': '支持图像',
        'member.seesImages': '视觉能力',
        'member.seesImagesAuto': '跟随模型上报',
        'member.seesImagesYes': '强制支持图像',
        'member.seesImagesNo': '强制不支持',
        'member.probe': '检测',
        'member.probeOk': '可用',
        'member.probeFail': '不可用',

        'pick.title': '选择模型',
        'pick.search': '搜索模型 ID 或名称',
        'pick.empty': '没有匹配的模型',
        'pick.add': '添加所选',
        'pick.cancel': '取消',
        'pick.already': '已在列表中',
        'pick.router': '本插件的挡位不能作为成员（会造成循环）',

        'expose.title': '模型选择器的显示',
        'expose.tiers': '只显示挡位',
        'expose.tiersHint': '隐藏真实模型，只留挡位。',
        'expose.custom': '只隐藏我勾选的',
        'expose.customHint': '挡位和未勾选的模型都显示。',
        'expose.all': '全部显示',
        'expose.allHint': '挡位和其它模型并排显示。默认。',
        'expose.blocked': '挡位还没有可用成员，暂不隐藏——否则选择器会变空。',
        'expose.hiding': '当前会隐藏 {hidden} / {total} 个模型',
        'expose.hideAll': '全选',
        'expose.hideNone': '全不选',

        'options.title': '高级',
        'options.timeout': '默认超时',
        'options.descriptions': '在模型选择器里显示挡位说明',
        'options.file': '配置文件',
        'options.copy': '复制路径',
        'options.copied': '已复制',
        'options.modalityRouting': '有图片时自动选能看图的成员',
        'options.modalityRoutingHint': '带图时跳过看不了图的成员。',
        'options.defaultEffort': '新对话默认强度',
        'options.defaultEffortModel': '跟随模型',
        'options.defaultEffortHint': '新会话预选的档位，已存在的会话不受影响。',
        'options.effortMapping': '思考强度自动映射',
        'options.effortMappingHint': '开启：选择器统一五档，按成员翻译。关闭：显示模型自己的档位并原样转发。',
        'options.logging': '记录调用日志',
        'options.logLimit': '保留条数',

        'tabs.configure': '配置',
        'tabs.settings': '设置',
        'tabs.preview': '预览',
        'tabs.log': '调用日志',

        'log.title': '调用日志',
        'log.refresh': '刷新',
        'log.clear': '清空',
        'log.empty': '还没有记录。发一条消息后再回来看看。',
        'log.emptyDisabled': '日志已关闭。在「设置 → 高级」里打开「记录调用日志」。',
        'log.count': '共 {n} 条',
        'log.ok': '成功',
        'log.retry': '重试',
        'log.failover': '换下一个',
        'log.aborted': '已取消',
        'log.failed': '全部失败',
        'log.exhausted': '超出上限',
        'log.answered': '作答',
        'log.attempt': '第 {n} 次',
        'log.elapsed': '{ms} ms',
        'log.tokens': '{input} 输入 / {output} 输出',
        'log.skipped': '跳过',
        'log.vision': '含图片',
        'log.contextSkip': '上下文装不下',
        'log.noVision': '无视觉',
        'log.noVisionMember': '挡位里没有能看图的成员',
        'log.dropped': '（另有 {n} 次尝试未显示）',
        'log.effortDropped': '未发送档位（模型未声明）',
        'log.effortSame': '档位 {level}',
        'log.effortMapped': '档位 {from} → {to}',

        'preview.hiddenAll': '（其余模型已全部隐藏）',
        'preview.tiers': 'Echelon',

        'units.sec': '秒',
      },
      en: {
        nav: 'Model Router',
        title: 'Model Router',
        loading: 'Loading…',
        loadFailed: 'Cannot reach the plugin backend',
        retry: 'Retry',
        save: 'Save',
        reload: 'Reload',
        saving: 'Saving…',
        saved: 'Saved.',
        saveFailed: 'Save failed',
        unsaved: 'Unsaved changes',

        'tiers.title': 'Tiers',
        'tiers.hint': 'Their order here is their order in the picker.',
        'tiers.add': 'New tier',
        'tiers.name': 'Name',
        'tiers.namePlaceholder': 'e.g. Daily / Heavy / Cheap',
        'tiers.enabled': 'Enabled',
        'tiers.disabled': 'Disabled',
        'tiers.up': 'Move up',
        'tiers.down': 'Move down',
        'tiers.remove': 'Delete',
        'tiers.removeConfirm': 'Delete tier “{name}”? Its members go with it.',
        'tiers.empty': 'No tiers yet. Add one, then add models to it.',
        'tiers.defaults': 'Tier defaults',
        'tiers.inherit': 'follow member',
        'tiers.useGlobal': 'global default',
        'tiers.members': 'Members (in order)',
        'tiers.membersEmpty': 'No models yet. Pick one to add.',
        'tiers.addMember': 'Add model',
        'tiers.maxTiers': 'At most {n} tiers',

        'member.provider': 'Route',
        'member.model': 'Model',
        'member.attempts': 'Retries',
        'member.timeout': 'Timeout',
        'member.timeoutUnit': 's',
        'member.unlimited': 'no limit',
        'member.follow': 'follow tier',
        'member.effort': 'Reasoning',
        'member.effortDefault': 'Follow session',
        'member.effortOff': 'No reasoning',
        'member.effortHint': '',
        'member.effortStale': 'not published',
        'member.context': 'Context window',
        'member.maxTokens': 'Max output',
        'member.defaultAuto': 'Model default',
        'member.enabled': 'Enabled',
        'member.remove': 'Remove',
        'member.up': 'Move up',
        'member.down': 'Move down',
        'member.missing': 'no longer in the catalog',
        'member.vision': 'Sees images',
        'member.seesImages': 'Vision',
        'member.seesImagesAuto': 'Follow the model',
        'member.seesImagesYes': 'Force: sees images',
        'member.seesImagesNo': 'Force: cannot see',
        'member.probe': 'Test',
        'member.probeOk': 'available',
        'member.probeFail': 'unavailable',

        'pick.title': 'Choose a model',
        'pick.search': 'Search model id or name',
        'pick.empty': 'No matching model',
        'pick.add': 'Add selected',
        'pick.cancel': 'Cancel',
        'pick.already': 'already added',
        'pick.router': 'This plugin’s own tiers cannot be members (that would loop)',

        'expose.title': 'What the model picker shows',
        'expose.tiers': 'Tiers only',
        'expose.tiersHint': 'Hide every real model, keep your tiers.',
        'expose.custom': 'Hide only what I check',
        'expose.customHint': 'Tiers and unchecked models stay visible.',
        'expose.all': 'Show everything',
        'expose.allHint': 'Tiers beside the stock models. Default.',
        'expose.blocked': 'No tier can dispatch yet, so nothing is hidden — the picker would be empty.',
        'expose.hiding': 'Hiding {hidden} of {total} models right now',
        'expose.hideAll': 'Check all',
        'expose.hideNone': 'Check none',

        'options.title': 'Advanced',
        'options.timeout': 'Default timeout',
        'options.descriptions': 'Show tier descriptions in the picker',
        'options.file': 'Settings file',
        'options.copy': 'Copy path',
        'options.copied': 'Copied',
        'options.modalityRouting': 'Route images to a model that can see',
        'options.modalityRoutingHint': 'Skip members that cannot see an attached image.',
        'options.defaultEffort': 'Default level for new chats',
        'options.defaultEffortModel': 'Follow the model',
        'options.defaultEffortHint': 'Preselected for new conversations only.',
        'options.effortMapping': 'Map reasoning levels automatically',
        'options.effortMappingHint': 'On: one five-level vocabulary, translated per member. Off: the model\'s own levels, forwarded as written.',
        'options.logging': 'Record a request log',
        'options.logLimit': 'Entries kept',

        'tabs.configure': 'Configure',
        'tabs.settings': 'Settings',
        'tabs.preview': 'Preview',
        'tabs.log': 'Request log',

        'log.title': 'Request log',
        'log.refresh': 'Refresh',
        'log.clear': 'Clear',
        'log.empty': 'Nothing yet. Send a message, then come back.',
        'log.emptyDisabled': 'Logging is off. Turn on “Record a request log” under Settings → Advanced.',
        'log.count': '{n} entries',
        'log.ok': 'answered',
        'log.retry': 'retried',
        'log.failover': 'failed over',
        'log.aborted': 'cancelled',
        'log.failed': 'all failed',
        'log.exhausted': 'attempt cap hit',
        'log.answered': 'answered by',
        'log.attempt': 'try {n}',
        'log.elapsed': '{ms} ms',
        'log.tokens': '{input} in / {output} out',
        'log.skipped': 'skipped',
        'log.vision': 'with image',
        'log.contextSkip': 'does not fit the context',
        'log.noVision': 'cannot see images',
        'log.noVisionMember': 'no image-capable member in this tier',
        'log.dropped': '({n} more attempts hidden)',
        'log.effortDropped': 'no level sent (model declares none)',
        'log.effortSame': 'level {level}',
        'log.effortMapped': 'level {from} → {to}',

        'preview.hiddenAll': '(every other model is hidden)',
        'preview.tiers': 'Model Router',

        'units.sec': 's',
      },
    }

    /** Active UI language: Chinese for any zh locale, English otherwise. */
    const lang = () => {
      try {
        const value = document.documentElement.lang || (navigator.language ?? 'en')
        return String(value).toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'en'
      }
    }
    const t = (key, params) => {
      const table = DICT[lang()] ?? DICT.en
      const template = table[key] ?? DICT.en[key] ?? key
      if (params === undefined) return template
      return template.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole))
    }

    // ── styles ──────────────────────────────────────────────────────────────
    // Every colour is a DSH theme variable, so light and dark follow the host
    // together. Two rules learned the hard way:
    //
    //   1. Only use variable names DSH actually defines. An undefined custom
    //      property invalidates the whole declaration, so `background:
    //      var(--typo)` silently becomes transparent and the surface shows the
    //      parent through it — a grey block with no rule that looks wrong.
    //      `--dsw-alias-bg-page-primary` was exactly that mistake.
    //   2. Layer surfaces with `bg-layer-1..4` (the host's own elevation ramp)
    //      rather than inventing a page colour, so nesting reads correctly in
    //      both schemes.
    const CSS = `
.mr-root{width:100%;max-width:760px;display:flex;flex-direction:column;gap:20px;color:var(--dsw-alias-label-primary)}
.mr-root h2{margin:0;font-size:22px;line-height:30px;font-weight:600}
.mr-root h3{margin:0;font-size:15px;line-height:22px;font-weight:600}
.mr-root p{margin:0;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary)}
.mr-root small{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.mr-head{display:flex;flex-direction:column;gap:8px}
/* The title row owns its breathing room: a heading sitting 2px above a tab strip
   reads as cramped, and the gap is the cheapest way to make the page composed.
   The button is nudged down a little relative to the title's optical centre —
   flush with the top edge it looked like it was falling out of the page. */
.mr-page-head{padding:6px 0 6px;align-items:flex-start}
.mr-page-head .mr-actions{margin-top:6px}
.mr-card{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:16px}
.mr-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.mr-spread{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.mr-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mr-root button{font:inherit;font-size:13px;cursor:pointer;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:5px 12px;line-height:20px}
.mr-root button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.mr-root button:disabled{opacity:.45;cursor:default}
.mr-root button.mr-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,#fff)}
.mr-root button.mr-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary))}
.mr-root button.mr-danger{color:var(--dsw-alias-state-error-primary)}
.mr-root button.mr-icon{padding:4px 8px;min-width:28px}
.mr-root :is(button,input,select,textarea):focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.mr-root input[type=text],.mr-root input[type=number],.mr-root input[type=search],.mr-root select{box-sizing:border-box;font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 9px;min-height:32px;min-width:0}
.mr-root input::placeholder{color:var(--dsw-alias-label-tertiary)}
.mr-tier{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.mr-tier.is-disabled{opacity:.6}
/* A tier collapses to one row. The summary is the whole "which tier is this"
   answer; the body is the editing surface nobody needs open by default. */
.mr-tier-summary{display:flex;align-items:center;gap:8px;padding:10px 12px;cursor:pointer;list-style:none;user-select:none;font-size:14px;font-weight:500}
.mr-tier-summary::-webkit-details-marker{display:none}
.mr-tier-summary:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mr-tier-summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.mr-tier[open] > .mr-tier-summary{border-bottom:1px solid var(--dsw-alias-border-l2)}
.mr-tier[open] .mr-disclosure-chevron{transform:rotate(90deg)}
.mr-tier-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mr-tier-body{display:flex;flex-direction:column;gap:12px;padding:12px}
.mr-dirty{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.mr-tier-head{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center}
.mr-tier-name{display:flex;align-items:center;gap:8px;min-width:0}
.mr-tier-name input{flex:1;min-width:80px;font-size:14px;font-weight:500}
.mr-pill{font-size:11px;line-height:16px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);white-space:nowrap;align-self:flex-start;width:fit-content}
.mr-members{display:flex;flex-direction:column;gap:8px}
.mr-member{display:flex;flex-direction:column;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:10px;background:var(--dsw-alias-bg-layer-1)}
.mr-member.is-off{opacity:.55}
.mr-member-main{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:center}
.mr-member-id{display:flex;flex-direction:column;gap:2px;min-width:0}
.mr-member-id code{font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mr-member-name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mr-member-knobs{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px 12px}
.mr-field{display:flex;flex-direction:column;gap:5px;min-width:0}
.mr-field > span{font-size:12px;line-height:16px;color:var(--dsw-alias-label-secondary)}
.mr-field .mr-input-row{display:flex;align-items:center;gap:6px}
.mr-field .mr-input-row input{width:100%}
/* No stepper arrows anywhere: a wheel event over a focused number field commits
   a different value while the user is scrolling the panel, and the arrow keys
   rewrite a half-typed number. These fields are plain text with a numeric
   keypad hint. */
input[type=number]::-webkit-outer-spin-button,input[type=number]::-webkit-inner-spin-button{-webkit-appearance:none;appearance:none;margin:0}
input[type=number]{-moz-appearance:textfield;appearance:textfield}
.mr-field input[inputmode]{font-variant-numeric:tabular-nums}
/* A stored level the model no longer publishes is visible but flagged. */
.mr-field select option[value].is-stale{color:var(--dsw-alias-state-warn-label,#9a6700)}
.mr-field .mr-unit{font-size:12px;color:var(--dsw-alias-label-tertiary);flex:none}
.mr-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;padding:14px;text-align:center}
.mr-radio{display:flex;gap:10px;align-items:flex-start;padding:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;cursor:pointer;background:var(--dsw-alias-bg-layer-2)}
.mr-radio.is-active{border-color:var(--dsw-alias-state-business-primary)}
.mr-radio input{margin-top:3px;flex:none}
.mr-radio-text{display:flex;flex-direction:column;gap:2px}
.mr-hide-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:6px 12px;max-height:320px;overflow:auto;padding:2px}
.mr-hide-group{display:flex;flex-direction:column;gap:2px;padding:6px 0}
.mr-hide-group > label{display:flex;align-items:center;gap:7px;font-size:13px;font-weight:500}
.mr-hide-model{display:flex;align-items:center;gap:7px;font-size:12px;padding-left:20px;color:var(--dsw-alias-label-secondary);overflow:hidden}
.mr-hide-model span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mr-modal{position:fixed;inset:0;z-index:1200;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.42));padding:24px}
.mr-modal-card{width:min(620px,100%);max-height:min(680px,calc(100vh - 48px));display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;padding:18px;box-shadow:var(--dsw-elevation-prominent)}
.mr-modal-list{overflow:auto;display:flex;flex-direction:column;gap:10px;min-height:0}
.mr-group{display:flex;flex-direction:column;gap:3px}
.mr-group-title{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary);padding:6px 2px 2px}
.mr-option{display:flex;align-items:center;gap:8px;padding:7px 8px;border-radius:8px;border:1px solid transparent;background:transparent;text-align:left;width:100%;color:inherit}
.mr-option:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.mr-option.is-selected{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}
.mr-option.is-disabled{opacity:.5;cursor:default}
.mr-option-text{display:flex;flex-direction:column;gap:1px;min-width:0;flex:1}
.mr-option-name{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mr-option-id{font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mr-alert{border-radius:8px;padding:9px 11px;font-size:12px;line-height:18px;background:var(--dsw-alias-interactive-bg-hover-danger);color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.mr-note{border-radius:8px;padding:9px 11px;font-size:12px;line-height:18px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
/* The card is already the frame, so the list inside it must not draw a second
   one: a bordered, filled panel inset into a bordered, filled card read as a box
   inside a box for no reason. The list keeps only what it needs — scrolling and
   a minimum height, so the preview claims the tab instead of collapsing to a
   short list above a large empty card. */
.mr-preview{display:flex;flex-direction:column;gap:2px;overflow:auto;min-height:min(58vh,520px)}
.mr-preview-card{gap:0;padding:14px 18px}
.mr-preview-block{display:flex;flex-direction:column;gap:2px;padding-top:10px}
.mr-preview-group{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary);padding:8px 0 2px}
.mr-preview-row{display:flex;align-items:center;gap:8px;font-size:13px;padding:3px 0}
.mr-preview-row .mr-check{color:var(--dsw-alias-label-primary);flex:none;width:14px}
.mr-preview-row.is-hidden{opacity:.35;text-decoration:line-through}
.mr-preview-note{font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary);padding:6px 0}
/* More air under the tab strip: the rule was touching the card below it. */
.mr-tabs{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:2px;margin-bottom:6px}
/* Collapsible detail block. One compact row that still describes itself: a
   bare chevron left a wide empty strip that said nothing about what it would
   open. The label stays visible; the inputs stay hidden until asked for. */
.mr-disclosure{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.mr-disclosure > summary{display:flex;align-items:center;gap:6px;padding:3px 8px;cursor:pointer;list-style:none;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);user-select:none;border-radius:6px}
.mr-disclosure > summary::-webkit-details-marker{display:none}
.mr-disclosure > summary:hover{background:var(--dsw-alias-interactive-bg-hover)}
.mr-disclosure > summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.mr-disclosure-chevron{flex:none;width:11px;text-align:center;transition:transform .15s ease;color:var(--dsw-alias-label-tertiary);font-size:13px}
.mr-disclosure[open] .mr-disclosure-chevron{transform:rotate(90deg)}
.mr-disclosure-meta{display:flex;align-items:baseline;gap:6px;min-width:0;flex:1;overflow:hidden}
.mr-disclosure-title{font-weight:500;color:var(--dsw-alias-label-primary);flex:none}
.mr-disclosure-digest{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}
.mr-disclosure-body{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;padding:4px 12px 12px;border-top:1px solid var(--dsw-alias-border-l2)}
.mr-disclosure-body.mr-plain{display:block;padding-top:10px}
@media(prefers-reduced-motion:reduce){.mr-disclosure-chevron{transition:none}}
.mr-tab{border:none;border-radius:8px 8px 0 0;background:transparent;padding:7px 14px;font-size:13px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.mr-tab.is-active{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font-weight:500}
.mr-log{display:flex;flex-direction:column;gap:8px}
.mr-log-row{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:9px 11px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:6px}
.mr-log-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:13px}
.mr-log-time{font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary);flex:none}
.mr-log-route{font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,monospace);font-size:12px;overflow-wrap:anywhere}
.mr-log-chain{display:flex;flex-direction:column;gap:2px;padding-left:2px}
.mr-log-attempt{display:flex;align-items:baseline;gap:6px;font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.mr-badge{font-size:11px;line-height:16px;padding:1px 7px;border-radius:999px;white-space:nowrap;flex:none}
.mr-badge.ok{background:var(--dsw-alias-state-success-primary,#1a7f37);color:#fff}
.mr-badge.retry{background:var(--dsw-alias-state-warn-label,#9a6700);color:#fff}
.mr-badge.failover{background:var(--dsw-alias-state-error-primary,#b35900);color:#fff}
.mr-badge.aborted{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.mr-badge.skipped{background:transparent;border:1px dashed var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}
.mr-log-usage{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.mr-log-empty{padding:18px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}
.mr-code{font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,monospace);font-size:11px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}
@media(max-width:560px){.mr-tier-head{grid-template-columns:1fr}.mr-member-main{grid-template-columns:1fr}}
`

    // ── helpers ─────────────────────────────────────────────────────────────

    /**
     * The page's sections, declared once so the tab strip and the body cannot
     * drift apart.
     *
     * The order follows the workflow rather than a taxonomy: you build tiers
     * (配置), check what the picker will look like (预览), then reach for
     * behaviour switches (设置) and finally the log. Preview sits directly after
     * 配置 because "did I build what I meant to" is the question you have before
     * you go changing defaults.
     *
     * 预览 is its own tab rather than the tail of 设置 because it is a *result*
     * you check, not a knob you set: it is read-only, and burying it under the
     * settings form made people scroll past it.
     */
    const TABS = [
      { id: 'configure', label: 'tabs.configure' },
      { id: 'preview', label: 'tabs.preview' },
      { id: 'settings', label: 'tabs.settings' },
      { id: 'log', label: 'tabs.log' },
    ]

    /** The sections shown on one tab. */
    const SECTIONS = {
      configure: ['tiers'],
      settings: ['exposure', 'advanced'],
      preview: ['preview'],
      log: [],
    }

    /** Call the plugin's own API. */
    async function api(path, options = {}) {
      const response = await fetch(`${API}${path}`, {
        credentials: 'same-origin',
        cache: 'no-store',
        ...options,
        headers: { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...options.headers },
      })
      const text = await response.text()
      const payload = text === '' ? {} : JSON.parse(text)
      if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
      return payload
    }

    /** Stable id for a new tier, derived from its name and de-duplicated. */
    function makeTierId(name, taken) {
      const base = String(name ?? '').trim().toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^[-.]+|[-.]+$/g, '')
        .slice(0, 40)
      const identity = base === '' || /[^\x20-\x7e]/.test(String(name ?? ''))
        ? `${base || 'tier'}-${hash32(String(name ?? ''))}`
        : base
      if (!taken.includes(identity)) return identity
      let suffix = 2
      while (taken.includes(`${identity}-${suffix}`)) suffix += 1
      return `${identity}-${suffix}`
    }

    /** Same hash the host uses, so a name maps to the same id on both sides. */
    function hash32(text) {
      let hash = 0x811c9dc5
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index)
        hash = Math.imul(hash, 0x01000193) >>> 0
      }
      return hash.toString(16).padStart(8, '0').slice(0, 6)
    }

    /** Deep clone a settings document through JSON (it is plain data by contract). */
    const clone = value => JSON.parse(JSON.stringify(value))

    /** Replace an item in an immutable list. */
    function replaceAt(list, index, next) {
      const copy = list.slice()
      copy[index] = next
      return copy
    }

    /**
     * The effort ladder the plugin always offers, strongest last.
     *
     * Mirrors `src/effort.js`. Duplicated here because the browser half ships as
     * one self-contained bundle and cannot import from the host side; the test
     * suite guards that the two lists agree.
     */
    const EFFORT_LADDER = ['off', 'low', 'middle', 'high', 'xhigh']

    /**
     * Parse `128k` / `1m` / `131072` into whole tokens.
     *
     * Mirrors `parseTokenBudget` in `src/config.js`, and for the same reason as
     * {@link EFFORT_LADDER}: one bundle, no host imports. The multipliers are
     * binary — "1M context" means 1,048,576 tokens, so `1m` has to mean that too.
     * @param {string} raw - typed text.
     * @returns {number | undefined} tokens, or undefined when unusable.
     */
    /**
     * Parse `128k` / `1m` / `256K` / `1.5M` / `131072` into whole tokens.
     *
     * Mirrors `parseTokenBudget` in `src/config.js`, and for the same reason as
     * {@link EFFORT_LADDER}: one bundle, no host imports. Decimal multipliers, so
     * `1m` = 1,000,000 and typing back exactly what the field shows never changes
     * the value.
     * @param {string} raw - typed text.
     * @returns {number | undefined} tokens, or undefined when unusable.
     */
    function parseTokens(raw) {
      const match = /^\s*(\d+(?:\.\d+)?)\s*([km])?\s*$/i.exec(String(raw))
      if (match === null) return undefined
      const amount = Number(match[1])
      if (!Number.isFinite(amount) || amount <= 0) return undefined
      const unit = (match[2] ?? '').toLowerCase()
      return Math.round(amount * (unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : 1))
    }

    /**
     * Render tokens back in the shortest form a person would write.
     *
     * `1000000` → `1m`, `262144` → `256k`, `131072` → `128k`. Below 1M the unit is
     * always `k` (never a raw digit string), because that is the whole point:
     * nobody wants to count zeros. A value that is not a clean multiple of 1024
     * stays exact — rounding it would silently change what gets saved next time.
     * 1000000 is not a multiple of 1048576 but is a recognisable "1M", so the
     * decimal million is folded onto `1m` as well.
     * @param {number | undefined} value - stored tokens.
     * @returns {string} field text, or '' when unset.
     */
    /**
     * Render tokens the way a person would say them: `1m`, `256k`, `128k`.
     *
     * Mirrors `formatTokenBudget` in `src/config.js`. Exact multiples keep their
     * own value (`128000` is `128k`); a provider's binary number (131072, 262144,
     * 1048576) is shown on the decimal scale (`131k`, `262k`, `1m`) because a
     * digit string in this field is exactly what was complained about.
     * @param {number | undefined} value - stored tokens.
     * @returns {string} field text, or '' when unset.
     */
    function formatTokens(value) {
      if (!Number.isFinite(value) || value <= 0) return ''
      const tokens = Math.round(value)
      if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}m`
      if (tokens % 1_000 === 0) return `${tokens / 1_000}k`
      if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}m`
      if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`
      return String(tokens)
    }

    /**
     * The levels to pin one member to: exactly what that model publishes.
     *
     * This is the *member* control, not the session picker, and the distinction
     * is the whole point of the 1.4.1 correction. A session level may be the
     * plugin's ladder, because dispatch translates it per member — but a value
     * stored on a member is sent to that member as-is, so offering a level it
     * never published would guarantee a rejected call. The model's own list is
     * the only honest menu here.
     * @param {Iterable<string>} [declared] - effort ids the member advertises.
     * @returns {string[]} option ids in display order.
     */
    function effortChoices(declared) {
      const out = []
      for (const id of declared === undefined ? [] : [...declared]) {
        if (typeof id !== 'string' || id === '' || out.includes(id)) continue
        out.push(id)
      }
      return out
    }

    /** Move one item within a list; out-of-range moves are no-ops. */
    function move(list, index, delta) {
      const target = index + delta
      if (target < 0 || target >= list.length) return list
      const copy = list.slice()
      const [item] = copy.splice(index, 1)
      copy.splice(target, 0, item)
      return copy
    }

    /** Seconds for display; the document stores milliseconds. */
    const toSeconds = ms => (Number(ms) === 0 ? 0 : Math.round(Number(ms) / 1000))
    /**
     * Milliseconds for storage, clamped to the range the Host accepts.
     *
     * These two numbers are duplicated from `src/config.js` because the bundle
     * cannot import the Host. They had drifted (5–900 here, 2–60 there), so the
     * panel silently rewrote a value the Host would have accepted — the "shortest
     * timeout is 3" change appeared to do nothing because this clamp still said 5.
     */
    const MIN_TIMEOUT_SEC = 3
    const MAX_TIMEOUT_SEC = 60
    const fromSeconds = seconds => {
      const value = Math.round(Number(seconds))
      if (!Number.isFinite(value) || value <= 0) return 0
      return Math.min(Math.max(value, MIN_TIMEOUT_SEC), MAX_TIMEOUT_SEC) * 1000
    }

    // ── controls ────────────────────────────────────────────────────────────

    function Field({ label, hint, children }) {
      return h('label', { className: 'mr-field' },
        h('span', null, label),
        children,
        // An empty hint renders nothing at all. A `<small>` with no text still
        // occupies a row and still sits in the accessibility tree, which is how a
        // form ends up looking unevenly spaced for no visible reason.
        hint === undefined || hint === '' ? null : h('small', null, hint))
    }

    /**
     * A collapsed-by-default block for the knobs most people never touch.
     *
     * Collapsed, it is just a small chevron: eight inputs per member made a
     * three-member tier taller than the settings panel, and the summary text was
     * repeating itself down the card. Expanded, the label and the current
     * values appear, because that is the moment you want to know what is set.
     *
     * The label survives collapsing as `aria-label` on the summary. Hiding it
     * visually but dropping it from the accessibility tree would leave a
     * nameless control that a screen reader can only announce as "button".
     *
     * Uses native `<details>` rather than React state on purpose: the browser
     * owns the open/closed state, it is keyboard-accessible for free, and it
     * survives a re-render without the page having to remember anything.
     * @param {{title?: string, digest?: string, children: any, plain?: boolean}} props - label, current values, and body.
     */
    function Disclosure({ title, digest, children, plain }) {
      const name = [title, digest].filter(part => part !== undefined && part !== '').join('：')
      return h('details', { className: 'mr-disclosure' },
        h('summary', { 'aria-label': name === '' ? undefined : name, title: name },
          h('span', { className: 'mr-disclosure-chevron', 'aria-hidden': 'true' }, '›'),
          h('span', { className: 'mr-disclosure-meta' },
            title === undefined ? null : h('span', { className: 'mr-disclosure-title' }, title),
            digest === undefined || digest === '' ? null : h('span', { className: 'mr-disclosure-digest' }, digest))),
        h('div', { className: plain === true ? 'mr-disclosure-body mr-plain' : 'mr-disclosure-body' }, children))
    }

    /**
     * A numeric input that never fights the person typing in it.
     *
     * Two separate mistakes are guarded against here, both reported:
     *
     * 1. `type: 'number'` renders a stepper that rewrites the value on an arrow
     *    key or a wheel event, so a half-typed number silently changes. The field
     *    is `text` with `inputMode="numeric"` instead, and the CSS suppresses any
     *    spinner a shell might draw anyway.
     * 2. Clamping on every keystroke. Typing "90" passes through "9", which the
     *    old code immediately rewrote to the minimum — so the box jumped to a
     *    big number the moment you tried to clear it and retype. A draft is now
     *    taken literally while it is being typed, and normalised exactly once,
     *    when the field is committed (blur or Enter).
     *
     * An empty box means "unset", which is a real choice and not the same as
     * zero, so the draft keeps the key absent rather than storing a sentinel.
     */
    function NumberInput({ value, min, max, onChange, ariaLabel, unit, placeholder }) {
      const [draft, setDraft] = useState(value === undefined ? '' : String(value))
      useEffect(() => { setDraft(value === undefined ? '' : String(value)) }, [value])
      /** Normalise the typed draft into a committed value. */
      const commit = () => {
        const text = draft.trim()
        if (text === '') { onChange(undefined); return }
        const parsed = Number(text)
        if (!Number.isFinite(parsed)) { setDraft(value === undefined ? '' : String(value)); return }
        const bounded = min === undefined && max === undefined
          ? Math.trunc(parsed)
          : Math.min(Math.max(Math.trunc(parsed), min ?? parsed), max ?? parsed)
        // Show the normalised number, so the box agrees with what was saved.
        setDraft(String(bounded))
        onChange(bounded)
      }
      return h('div', { className: 'mr-input-row' },
        h('input', {
          type: 'text', inputMode: 'numeric', autoComplete: 'off', spellCheck: false,
          value: draft, 'aria-label': ariaLabel, placeholder,
          // Digits only, in the field, at all times — no clamping.
          onChange: event => setDraft(event.target.value.replace(/[^\d]/g, '')),
          onBlur: commit,
          onKeyDown: event => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            commit()
            event.currentTarget.blur()
          },
        }),
        unit === undefined ? null : h('span', { className: 'mr-unit' }, unit))
    }

    // ── model picker dialog ─────────────────────────────────────────────────

    /**
     * The "add a model" dialog.
     *
     * Lists the live catalog grouped by provider route, with a search box that
     * matches id and name. Routes that cannot legitimately be members are
     * rendered but disabled, so the reason is visible instead of the model
     * silently missing.
     */
    function ModelPicker({ catalog, taken, onPick, onClose }) {
      const [query, setQuery] = useState('')
      const [selected, setSelected] = useState(undefined)
      const inputRef = useRef(null)
      useEffect(() => { inputRef.current?.focus() }, [])
      useEffect(() => {
        const onKey = event => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])

      const groups = useMemo(() => {
        const needle = query.trim().toLowerCase()
        const rows = []
        for (const group of catalog) {
          const models = group.models.filter(model => {
            if (needle === '') return true
            return `${group.id}/${model.id}`.toLowerCase().includes(needle)
              || String(model.name ?? '').toLowerCase().includes(needle)
          })
          if (models.length > 0) rows.push({ ...group, models })
        }
        return rows
      }, [catalog, query])

      const key = selected === undefined ? '' : `${selected.provider}/${selected.model}`

      return h('div', {
        className: 'mr-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('pick.title'),
        onMouseDown: event => { if (event.target === event.currentTarget) onClose() },
      }, h('div', { className: 'mr-modal-card' },
        h('div', { className: 'mr-spread' }, h('h3', null, t('pick.title')),
          h('button', { type: 'button', className: 'mr-icon', onClick: onClose, 'aria-label': t('pick.cancel') }, '✕')),
        h('input', {
          ref: inputRef, type: 'search', value: query, placeholder: t('pick.search'), 'aria-label': t('pick.search'),
          onChange: event => setQuery(event.target.value),
        }),
        h('div', { className: 'mr-modal-list' },
          groups.length === 0
            ? h('p', null, t('pick.empty'))
            : groups.map(group => h('div', { key: group.id, className: 'mr-group' },
              h('div', { className: 'mr-group-title' }, group.name ?? group.id),
              group.models.map(model => {
                const route = { provider: group.id, model: model.id }
                const already = taken.includes(`${group.id}/${model.id}`)
                const blocked = group.id === ROUTER_PROVIDER || already
                const isSelected = key === `${group.id}/${model.id}`
                return h('button', {
                  key: model.id, type: 'button',
                  className: `mr-option${isSelected ? ' is-selected' : ''}${blocked ? ' is-disabled' : ''}`,
                  disabled: blocked,
                  title: blocked ? (group.id === ROUTER_PROVIDER ? t('pick.router') : t('pick.already')) : undefined,
                  onClick: () => setSelected(blocked ? undefined : route),
                  onDoubleClick: () => { if (!blocked) { setSelected(route); onPick(route) } },
                },
                h('div', { className: 'mr-option-text' },
                  h('span', { className: 'mr-option-name' }, model.name ?? model.id),
                  h('span', { className: 'mr-option-id' }, `${group.id}/${model.id}`)),
                already ? h('span', { className: 'mr-pill' }, t('pick.already')) : null)
              })))
        ),
        h('div', { className: 'mr-spread' },
          h('small', null, catalog.length === 0 ? t('pick.empty') : ''),
          h('div', { className: 'mr-actions' },
            h('button', { type: 'button', onClick: onClose }, t('pick.cancel')),
            h('button', {
              type: 'button', className: 'mr-primary', disabled: selected === undefined,
              onClick: () => { if (selected !== undefined) onPick(selected) },
            }, t('pick.add'))))))
    }

    // ── member row ──────────────────────────────────────────────────────────

    /**
     * A token budget written the way people say it: `128k`, `1m`, or plain
     * digits.
     *
     * A context window is 128000 or 1048576, and typing those digits by hand is
     * an invitation to add or drop a zero. The field therefore accepts a suffix
     * and shows the stored value back in the same short form, so "what I set" and
     * "what I see" are the same string. Digits alone are still accepted, because
     * that is what a copied value looks like.
     *
     * `k` is 1024 and `m` is 1048576 — binary multiples, because every model that
     * advertises "1M context" means 1,048,576 tokens and rounding down to 1e6
     * would file the override 4.8% short of the real window.
     */
    /**
     * A token budget written the way people say it: `128k`, `1m`, `256K`, `1.5M`.
     *
     * Display and input are the same short form on purpose. A context window is
     * 1000000 or 1048576; showing that digit string and expecting the reader to
     * count zeros was the actual complaint, so a stored value renders as `1m` and
     * anything below 1M renders in `k` (`256k`, `512k`). Whole numbers that are
     * not clean multiples stay exact, because rounding them would change what is
     * saved on the next edit.
     *
     * `k` is 1024 and `m` is 1048576 — binary, because a model advertising "1M
     * context" means 1,048,576 tokens.
     *
     * While typing, the field is left alone (no rewriting mid-word); it is parsed
     * on blur or Enter, and the parsed value is shown back in short form.
     */
    function TokenInput({ value, ariaLabel, placeholder, onChange }) {
      const [draft, setDraft] = useState(formatTokens(value))
      useEffect(() => { setDraft(formatTokens(value)) }, [value])
      /** Commit whatever the box currently says. */
      const commit = text => {
        const trimmed = text.trim()
        if (trimmed === '') { onChange(undefined); setDraft(''); return }
        const parsed = parseTokens(trimmed)
        if (parsed === undefined) { setDraft(formatTokens(value)); return }
        const bounded = Math.min(Math.max(Math.round(parsed), 1_024), 4_000_000)
        onChange(bounded)
        // Echo the stored number back in short form, so "what I typed" and "what
        // is saved" are visibly the same thing.
        setDraft(formatTokens(bounded))
      }
      return h('input', {
        type: 'text', inputMode: 'text', autoComplete: 'off', spellCheck: false,
        value: draft, 'aria-label': ariaLabel, placeholder,
        onChange: event => setDraft(event.target.value),
        onBlur: () => commit(draft),
        onKeyDown: event => {
          if (event.key !== 'Enter') return
          event.preventDefault()
          commit(draft)
          event.currentTarget.blur()
        },
      })
    }

    /** One member: route identity, its own knobs, and its place in the chain. */
    function MemberRow({ member, index, total, catalog, probe, onChange, onMove, onRemove }) {
      const known = catalog.find(group => group.id === member.provider)
        ?.models.find(model => model.id === member.model)
      const verdict = probe?.[`${member.provider}/${member.model}`]
      // Effort options come from the live probe when it has run (that is the
      // model's own declaration), falling back to the catalog entry.
      const declared = verdict?.efforts ?? known?.efforts ?? []
      const efforts = effortChoices(declared)
      const inheritedContext = verdict?.contextWindow ?? known?.contextWindow
      const inheritedMax = verdict?.maxTokens ?? known?.maxTokens
      /** Drop a key so the field falls back to "inherit". */
      const without = key => {
        const { [key]: _drop, ...rest } = member
        return rest
      }
      return h('div', { className: `mr-member${member.enabled === false ? ' is-off' : ''}` },
        h('div', { className: 'mr-member-main' },
          h('div', { className: 'mr-member-id' },
            h('span', { className: 'mr-member-name' }, known?.name ?? member.model),
            h('code', { title: `${member.provider}/${member.model}` }, `${member.provider}/${member.model}`),
            known === undefined ? h('small', null, t('member.missing')) : null,
            (verdict?.inputModalities ?? known?.inputModalities ?? []).includes('image')
              ? h('span', { className: 'mr-pill', title: t('member.vision') }, '● ' + t('member.vision'))
              : null,
            verdict === undefined
              ? null
              : h('small', { style: { color: verdict.ok ? 'var(--dsw-alias-state-success-primary, #3a3)' : 'var(--dsw-alias-state-error-primary)' } },
                verdict.ok ? t('member.probeOk') : `${t('member.probeFail')}: ${verdict.error ?? ''}`)),
          h('div', { className: 'mr-actions' },
            h('label', { className: 'mr-row', title: t('member.enabled') },
              h('input', {
                type: 'checkbox', checked: member.enabled !== false,
                onChange: event => onChange({ ...member, enabled: event.target.checked }),
              }),
              h('span', { style: { fontSize: '12px' } }, t('member.enabled'))),
            h('button', {
              type: 'button', className: 'mr-icon', 'aria-label': t('member.up'), title: t('member.up'),
              disabled: index === 0, onClick: () => onMove(-1),
            }, '↑'),
            h('button', {
              type: 'button', className: 'mr-icon', 'aria-label': t('member.down'), title: t('member.down'),
              disabled: index === total - 1, onClick: () => onMove(1),
            }, '↓'),
            h('button', {
              type: 'button', className: 'mr-icon mr-danger', 'aria-label': t('member.remove'), title: t('member.remove'),
              onClick: onRemove,
            }, '✕'))),
        // Eight inputs per member made a three-member tier taller than the
        // settings panel, so the knobs live behind a disclosure. The digest
        // repeats their current values, which is what you came to check — and it
        // has to cope with "unset", which is now a real state: rendering
        // `undefined` or `NaN` here is what a naive concatenation produces.
        h(Disclosure, {
          digest: [
            member.attempts === undefined ? t('member.follow') : `${t('member.attempts')} ${member.attempts}`,
            member.idleTimeoutMs === undefined
              ? t('member.follow')
              : member.idleTimeoutMs === 0 ? t('member.unlimited') : `${toSeconds(member.idleTimeoutMs)}${t('member.timeoutUnit')}`,
            member.reasoningEffort === undefined ? t('member.effortDefault') : member.reasoningEffort,
            member.contextWindow === undefined
              ? `${t('member.context')} ${inheritedContext === undefined ? t('member.defaultAuto') : formatTokens(inheritedContext)}`
              : `${t('member.context')} ${formatTokens(member.contextWindow)}`,
          ].join(' · '),
        },
        h('div', { className: 'mr-member-knobs' },
          // An empty box means "inherit from the tier, then the global default".
          // Explicit `0` is still honoured where it means something, so clearing
          // the field is distinct from typing zero.
          h(Field, { label: t('member.attempts') },
            h(NumberInput, {
              value: member.attempts, min: 0, max: 5, ariaLabel: t('member.attempts'),
              placeholder: t('tiers.inherit'),
              onChange: attempts => onChange(attempts === undefined
                ? without('attempts')
                : { ...member, attempts: Math.min(Math.max(attempts, 0), 5) }),
            })),
          h(Field, { label: t('member.timeout') },
            h(NumberInput, {
              value: member.idleTimeoutMs === undefined ? undefined : toSeconds(member.idleTimeoutMs),
              min: 0, max: MAX_TIMEOUT_SEC, unit: t('member.timeoutUnit'),
              ariaLabel: t('member.timeout'), placeholder: t('tiers.inherit'),
              onChange: seconds => onChange(seconds === undefined
                ? without('idleTimeoutMs')
                : { ...member, idleTimeoutMs: fromSeconds(seconds) }),
            })),
          h(Field, { label: t('member.effort'), hint: t('member.effortHint') },
            h('select', {
              value: member.reasoningEffort ?? '', 'aria-label': t('member.effort'),
              onChange: event => onChange(event.target.value === ''
                ? without('reasoningEffort')
                : { ...member, reasoningEffort: event.target.value }),
            },
            h('option', { value: '' }, t('member.effortDefault')),
            // A value saved before the model changed its levels stays visible so
            // the user can change it, but it is marked: it is not something this
            // model publishes, and dispatch will translate or drop it.
            member.reasoningEffort !== undefined && !efforts.includes(member.reasoningEffort)
              ? h('option', { key: '__stored', value: member.reasoningEffort },
                efforts.length === 0
                  ? member.reasoningEffort
                  : `${member.reasoningEffort}（${t('member.effortStale')}）`)
              : null,
            efforts.map(effort => h('option', { key: effort, value: effort }, effort)))),
          h(Field, { label: t('member.context') },
            h(TokenInput, {
              value: member.contextWindow, ariaLabel: t('member.context'),
              placeholder: inheritedContext === undefined ? t('member.defaultAuto') : formatTokens(inheritedContext),
              onChange: contextWindow => onChange(contextWindow === undefined
                ? without('contextWindow')
                : { ...member, contextWindow }),
            })),
          h(Field, { label: t('member.maxTokens') },
            h(TokenInput, {
              value: member.maxTokens, ariaLabel: t('member.maxTokens'),
              placeholder: inheritedMax === undefined ? t('member.defaultAuto') : formatTokens(inheritedMax),
              onChange: maxTokens => onChange(maxTokens === undefined ? without('maxTokens') : { ...member, maxTokens }),
            })),
          h(Field, { label: t('member.seesImages') },
            h('select', {
              value: member.seesImages === true ? 'yes' : member.seesImages === false ? 'no' : '',
              'aria-label': `${member.model} ${t('member.seesImages')}`,
              onChange: event => onChange(event.target.value === ''
                ? without('seesImages')
                : { ...member, seesImages: event.target.value === 'yes' }),
            },
            h('option', { value: '' }, t('member.seesImagesAuto')),
            h('option', { value: 'yes' }, t('member.seesImagesYes')),
            h('option', { value: 'no' }, t('member.seesImagesNo')))))))
    }

    // ── tier card ───────────────────────────────────────────────────────────

    /**
     * One tier: name, enable state, ordering, and its member chain.
     *
     * Collapsible, because a three-tier page with six members each is a wall of
     * inputs and the only thing you usually want is the list of names. `<details>`
     * again, for the same reasons as {@link Disclosure}: the browser owns the
     * state, it survives a re-render, and it is keyboard-accessible for free.
     *
     * The member count pill is gone. It repeated what opening the row shows, and
     * a number next to a heading reads as "there are six of something to deal
     * with" rather than as information.
     */
    function TierCard({ tier, index, total, catalog, probe, onChange, onMove, onRemove, onAddMember }) {
      return h('details', {
        className: `mr-tier${tier.enabled === false ? ' is-disabled' : ''}`,
        open: tier.members.length === 0 ? true : undefined,
      },
        h('summary', { className: 'mr-tier-summary' },
          h('span', { className: 'mr-disclosure-chevron', 'aria-hidden': 'true' }, '›'),
          h('span', { className: 'mr-tier-label' }, tier.name === '' ? t('tiers.namePlaceholder') : tier.name),
          tier.enabled === false ? h('span', { className: 'mr-pill' }, t('tiers.disabled')) : null),
        h('div', { className: 'mr-tier-body' },
          h('div', { className: 'mr-tier-head' },
            h('div', { className: 'mr-tier-name' },
              h('input', {
                type: 'text', value: tier.name, 'aria-label': t('tiers.name'), placeholder: t('tiers.namePlaceholder'),
                onChange: event => onChange({ ...tier, name: event.target.value }),
              })),
            h('div', { className: 'mr-actions' },
              h('label', { className: 'mr-row' },
                h('input', {
                  type: 'checkbox', checked: tier.enabled !== false,
                  onChange: event => onChange({ ...tier, enabled: event.target.checked }),
                }),
                h('span', { style: { fontSize: '12px' } }, tier.enabled === false ? t('tiers.disabled') : t('tiers.enabled'))),
              h('button', { type: 'button', className: 'mr-icon', disabled: index === 0, title: t('tiers.up'), 'aria-label': t('tiers.up'), onClick: () => onMove(-1) }, '↑'),
              h('button', { type: 'button', className: 'mr-icon', disabled: index === total - 1, title: t('tiers.down'), 'aria-label': t('tiers.down'), onClick: () => onMove(1) }, '↓'),
              h('button', { type: 'button', className: 'mr-icon mr-danger', title: t('tiers.remove'), 'aria-label': t('tiers.remove'), onClick: onRemove }, '✕'))),
          // Tier-level defaults for the two knobs that are worth applying to a
          // whole chain: how long to wait, and how many retries. A member that
          // sets its own value wins, so these fill the gaps, never override.
          h(Disclosure, {
            title: t('tiers.defaults'),
            digest: [
              tier.idleTimeoutMs === undefined ? t('member.defaultAuto') : `${toSeconds(tier.idleTimeoutMs)}${t('member.timeoutUnit')}`,
              tier.attempts === undefined ? t('member.defaultAuto') : String(tier.attempts),
            ].join(' · '),
          },
          h('div', { className: 'mr-member-knobs' },
            h(Field, { label: t('member.timeout') },
              h(NumberInput, {
                // A tier has nothing above it but the global default, so `0` here
                // clears the tier value and lets that apply — unlike a member,
                // where `0` genuinely means "no limit".
                value: tier.idleTimeoutMs === undefined ? undefined : toSeconds(tier.idleTimeoutMs),
                ariaLabel: `${tier.name} ${t('member.timeout')}`,
                min: 0, max: MAX_TIMEOUT_SEC, unit: t('member.timeoutUnit'),
                placeholder: t('tiers.useGlobal'),
                onChange: seconds => {
                  const { idleTimeoutMs: _drop, ...rest } = tier
                  onChange(seconds === undefined || seconds === 0 ? rest : { ...rest, idleTimeoutMs: fromSeconds(seconds) })
                },
              })),
            h(Field, { label: t('member.attempts') },
              h(NumberInput, {
                value: tier.attempts, ariaLabel: `${tier.name} ${t('member.attempts')}`,
                min: 0, max: 5, placeholder: t('tiers.useGlobal'),
                onChange: attempts => {
                  const { attempts: _drop, ...rest } = tier
                  onChange(attempts === undefined || attempts === 0 ? rest : { ...rest, attempts })
                },
              })),
            h(Field, { label: t('member.context') },
              h(TokenInput, {
                value: tier.contextWindow, ariaLabel: `${tier.name} ${t('member.context')}`,
                placeholder: t('member.defaultAuto'),
                onChange: contextWindow => {
                  const { contextWindow: _drop, ...rest } = tier
                  onChange(contextWindow === undefined ? rest : { ...rest, contextWindow })
                },
              })))),
          h('div', { className: 'mr-row' }, h('h3', { style: { fontSize: '13px' } }, t('tiers.members'))),
          tier.members.length === 0
            ? h('div', { className: 'mr-empty' }, h('p', null, t('tiers.membersEmpty')))
            : h('div', { className: 'mr-members' }, tier.members.map((member, memberIndex) => h(MemberRow, {
              key: `${member.provider}/${member.model}`,
              member, index: memberIndex, total: tier.members.length, catalog, probe,
              onChange: next => onChange({ ...tier, members: replaceAt(tier.members, memberIndex, next) }),
              onMove: delta => onChange({ ...tier, members: move(tier.members, memberIndex, delta) }),
              onRemove: () => onChange({ ...tier, members: tier.members.filter((_, position) => position !== memberIndex) }),
            }))),
          h('div', null, h('button', { type: 'button', onClick: onAddMember }, `+ ${t('tiers.addMember')}`))))
    }

    // ── request log ─────────────────────────────────────────────────────────

    /**
     * The dictionary key that names why a member was skipped.
     *
     * Previously every skipped row with a message rendered as "does not fit the
     * context", so a member dropped for having no vision was reported as a
     * context problem — a false explanation in the one place a user goes to find
     * out why their image was ignored.
     * @param {string | undefined} code - the skip code.
     * @returns {string} a dictionary key.
     */
    function skipReasonKey(code) {
      if (code === 'NO_VISION') return 'log.noVision'
      if (code === 'NO_VISION_MEMBER') return 'log.noVisionMember'
      if (code === 'CONTEXT_TOO_SMALL') return 'log.contextSkip'
      return code === undefined ? 'log.skipped' : code
    }

    /** One logged attempt: which member, which try, and how it ended. */
    function LogAttempt({ attempt }) {
      const skipped = attempt.outcome === 'skipped'
      const badge = skipped ? 'skipped'
        : attempt.outcome === 'ok' ? 'ok'
          : attempt.outcome === 'retry' ? 'retry'
            : attempt.outcome === 'aborted' ? 'aborted' : 'failover'
      const label = skipped ? t('log.skipped')
        : attempt.outcome === 'ok' ? t('log.ok')
          : attempt.outcome === 'retry' ? t('log.retry')
            : attempt.outcome === 'aborted' ? t('log.aborted') : t('log.failover')
      return h('div', { className: 'mr-log-attempt' },
        h('span', { className: `mr-badge ${badge}` }, label),
        h('span', { className: 'mr-log-route' }, `${attempt.provider}/${attempt.model}`),
        // A skipped member was never dialled, so "try 0" would be misleading.
        skipped ? null : h('span', null, t('log.attempt', { n: attempt.attempt })),
        attempt.durationMs === undefined ? null : h('span', null, t('log.elapsed', { ms: attempt.durationMs })),
        skipped
          ? h(Fragment, null,
            h('span', null, t(skipReasonKey(attempt.code))),
            attempt.message === undefined ? null : h('span', { className: 'mr-log-usage' }, attempt.message))
          : attempt.code === undefined ? null : h('span', null, attempt.code))
    }

    /**
     * The reasoning level as it left the router, shown only when it says
     * something the route line does not.
     *
     * Three cases worth surfacing, in the user's own terms:
     * - translated (`xhigh → max`): the tier asked for one thing and the member
     *   heard another, which is the whole point of the mapping switch;
     * - dropped: the member publishes no levels, so nothing was sent and the model
     *   used its own default — the case that used to fail the call outright;
     * - unchanged: still shown while the session has a level, because "which one
     *   did it actually use" is the question the log exists to answer.
     * @param {object} entry - one committed log entry.
     * @returns {any} a span, or null when there is nothing to say.
     */
    function effortLabel(entry) {
      const requested = entry.requestedEffort
      const sent = entry.effort
      if (requested === undefined && sent === undefined) return null
      if (sent === undefined && entry.effortDropped === true) {
        return h('span', { className: 'mr-log-usage' }, t('log.effortDropped'))
      }
      if (requested === undefined || sent === undefined) {
        return h('span', { className: 'mr-log-usage' }, t('log.effortSame', { level: sent ?? requested }))
      }
      return h('span', { className: 'mr-log-usage' }, requested === sent
        ? t('log.effortSame', { level: sent })
        : t('log.effortMapped', { from: requested, to: sent }))
    }

    /** One logged request: the outcome, the winner, and the chain behind it. */
    function LogRow({ entry }) {
      const outcome = entry.outcome
      const badge = outcome === 'ok' ? 'ok'
        : outcome === 'aborted' ? 'aborted'
          : outcome === 'failed' || outcome === 'exhausted' ? 'failover' : 'retry'
      const label = outcome === 'ok' ? t('log.ok')
        : outcome === 'aborted' ? t('log.aborted')
          : outcome === 'exhausted' ? t('log.exhausted')
            : outcome === 'failed' ? t('log.failed') : outcome
      const time = new Date(entry.startedAt)
      const clock = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}:${String(time.getSeconds()).padStart(2, '0')}`
      return h('div', { className: 'mr-log-row' },
        h('div', { className: 'mr-log-head' },
          h('span', { className: `mr-badge ${badge}` }, label),
          h('strong', { style: { fontWeight: 500 } }, entry.tierName ?? entry.tier),
          entry.vision === true ? h('span', { className: 'mr-pill' }, t('log.vision')) : null,
          h('span', { className: 'mr-log-time' }, clock),
          h('span', { className: 'mr-log-time' }, t('log.elapsed', { ms: entry.durationMs }))),
        // The route the turn actually took: the tier the user picked, then the
        // real model that served it, then the reasoning level as it was translated
        // on the way out. Three different vocabularies on one line — the tier name
        // is the user's, the route is the provider's, the level may be neither.
        h('div', { className: 'mr-log-head' },
          h('span', { className: 'mr-log-route' }, entry.provider === undefined
            ? `${entry.tierName ?? entry.tier} → ${t('log.failed')}`
            : `${entry.tierName ?? entry.tier} → ${entry.provider}/${entry.model}`),
          effortLabel(entry)),
        entry.usage === undefined
          ? null
          : h('span', { className: 'mr-log-usage' },
            t('log.tokens', { input: entry.usage.inputTokens ?? '?', output: entry.usage.outputTokens ?? '?' })),
        entry.attempts.length === 0
          ? null
          : h('div', { className: 'mr-log-chain' }, entry.attempts.map((attempt, at) => h(LogAttempt, {
            key: `${attempt.provider}/${attempt.model}/${attempt.attempt}/${at}`,
            attempt,
          }))),
        entry.droppedAttempts > 0 ? h('span', { className: 'mr-log-usage' }, t('log.dropped', { n: entry.droppedAttempts })) : null,
        entry.message === undefined || outcome === 'ok'
          ? null
          : h('span', { className: 'mr-log-usage', style: { overflowWrap: 'anywhere' } }, entry.message))
    }

    /**
     * The request-log tab.
     *
     * Polls while visible rather than subscribing: the log lives on the Host, and
     * a settings page that is open for minutes should show turns that happened
     * in between without the user pressing Refresh.
     */
    function LogPanel({ enabled }) {
      const [view, setView] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        try {
          const payload = await api('/log?limit=200')
          setView(payload)
          setError(undefined)
        } catch (cause) {
          setError(String(cause.message ?? cause))
        }
      }, [])

      useEffect(() => {
        void load()
        const timer = setInterval(() => { void load() }, 3_000)
        return () => clearInterval(timer)
      }, [load])

      const clear = useCallback(async () => {
        setBusy(true)
        try {
          await api('/log/clear', { method: 'POST', body: '{}' })
          await load()
        } catch (cause) {
          setError(String(cause.message ?? cause))
        } finally {
          setBusy(false)
        }
      }, [load])

      if (!enabled) {
        return h('section', { className: 'mr-card' },
          h('h3', null, t('log.title')),
          h('p', null, t('log.emptyDisabled')))
      }

      return h('section', { className: 'mr-card' },
        h('div', { className: 'mr-spread' },
          h('h3', null, t('log.title')),
          h('div', { className: 'mr-actions' },
            h('span', { className: 'mr-pill' }, view === undefined ? '' : t('log.count', { n: view.total })),
            h('button', { type: 'button', onClick: () => { void load() } }, t('log.refresh')),
            h('button', { type: 'button', disabled: busy || (view?.total ?? 0) === 0, onClick: () => { void clear() } }, t('log.clear')))),
        error === undefined ? null : h('div', { className: 'mr-alert', role: 'alert' }, error),
        view === undefined
          ? h('p', { role: 'status' }, t('loading'))
          : view.entries.length === 0
            ? h('div', { className: 'mr-log-empty' }, t('log.empty'))
            : h('div', { className: 'mr-log' }, view.entries.map(entry => h(LogRow, { key: entry.id, entry }))))
    }

    // ── main page ───────────────────────────────────────────────────────────

    /** The settings section. */
    function RouterSettings() {
      const [state, setState] = useState(undefined)
      const [draft, setDraft] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [notice, setNotice] = useState(undefined)
      const [saving, setSaving] = useState(false)
      const [picker, setPicker] = useState(undefined)
      const [probe, setProbe] = useState({})
      const [copied, setCopied] = useState(false)
      // Opens on 配置: the tier list is what the page is for, and it is where a
      // first-time user has to start before anything else here matters.
      const [tab, setTab] = useState('configure')
      const dirtyRef = useRef(false)
      dirtyRef.current = draft !== undefined && state !== undefined && JSON.stringify(draft) !== JSON.stringify(state.settings)

      const load = useCallback(async () => {
        setError(undefined)
        try {
          const payload = await api('/state')
          setState(payload)
          setDraft(clone(payload.settings))
          setNotice(undefined)
        } catch (cause) {
          setError(String(cause.message ?? cause))
        }
      }, [])
      useEffect(() => { void load() }, [load])

      /**
       * One button for both cases.
       *
       * With unsaved edits it writes, then reloads, so the page shows what the
       * Host actually stored rather than the draft. With nothing to save it just
       * reloads — which is what the old "Reload" button did, minus the extra
       * button. A separate "Discard" is gone too: it only made sense while the
       * save was already explicit elsewhere, and its state was a third thing to
       * reason about.
       */
      const save = useCallback(async () => {
        if (dirtyRef.current && draft !== undefined) {
          setSaving(true)
          setError(undefined)
          setNotice(undefined)
          try {
            // Order is the picker's order, so the array position is normalized
            // here instead of asking the user to think about an `order` field.
            const payload = { ...draft, tiers: draft.tiers.map((tier, index) => ({ ...tier, order: index })) }
            const result = await api('/settings', { method: 'POST', body: JSON.stringify({ settings: payload }) })
            setState(current => ({ ...current, settings: result.settings }))
            setDraft(clone(result.settings))
            setNotice(t('saved'))
          } catch (cause) {
            setError(`${t('saveFailed')}：${String(cause.message ?? cause)}`)
            setSaving(false)
            return
          }
          setSaving(false)
        }
        // Always finish with a fresh read: after a write it is the source of
        // truth, and with no write it is the manual refresh the button offers.
        await load()
      }, [draft, load])

      // Defensive on purpose: a malformed catalog must degrade to "no models to
      // pick from", never to a thrown panel. `Array.isArray` also rejects the
      // `{}` a handler bug produces when it serializes an unresolved Promise.
      const rawCatalog = state?.catalog
      const catalog = Array.isArray(rawCatalog)
        ? rawCatalog
          .filter(group => group !== null && typeof group === 'object' && typeof group.id === 'string')
          .map(group => ({ ...group, models: Array.isArray(group.models) ? group.models : [] }))
        : []
      const settings = draft
      const takenRoutes = useMemo(() => {
        if (settings === undefined || picker === undefined) return []
        const tier = settings.tiers.find(candidate => candidate.id === picker)
        return (tier?.members ?? []).map(member => `${member.provider}/${member.model}`)
      }, [settings, picker])

      const hiddenCounts = useMemo(() => {
        if (settings === undefined) return { hidden: 0, total: 0 }
        let hidden = 0
        let total = 0
        for (const group of catalog) {
          for (const model of group.models) {
            total += 1
            const pair = `${group.id}/${model.id}`
            if (settings.exposure === 'tiers') hidden += 1
            else if (settings.exposure === 'custom'
              && settings.hide.some(rule => rule.enabled && (rule.target === group.id || rule.target === pair))) hidden += 1
          }
        }
        return { hidden, total }
      }, [settings, catalog])

      const anyDispatchable = useMemo(() => {
        if (settings === undefined) return false
        return settings.tiers.some(tier => tier.enabled !== false
          && tier.members.some(member => member.enabled !== false
            && catalog.some(group => group.id === member.provider && group.models.some(model => model.id === member.model))))
      }, [settings, catalog])

      const updateTier = useCallback((index, next) => {
        setDraft(current => ({ ...current, tiers: replaceAt(current.tiers, index, next) }))
        setProbe({})
      }, [])

      /**
       * Refresh one tier's member verdicts.
       *
       * There is no "probe" button any more: the check ran once, on demand, and
       * then went stale the moment a member changed. It now runs automatically
       * after a member is added or edited, which is the only moment the answer is
       * actionable — the tile shows whether the lane resolves, and whether it can
       * see images, without asking the user to press anything.
       */
      const runProbe = useCallback(async tierId => {
        try {
          const result = await api('/probe', { method: 'POST', body: JSON.stringify({ tier: tierId }) })
          setProbe(current => ({
            ...current,
            ...Object.fromEntries(result.members.map(member => [`${member.provider}/${member.model}`, member])),
          }))
        } catch {
          // A failed probe only leaves the verdicts unknown; it must not replace
          // the panel with an error the user cannot act on.
        }
      }, [])

      if (error !== undefined && state === undefined) {
        return h('div', { className: 'mr-root' },
          h('style', null, CSS),
          h('div', { className: 'mr-head' }, h('h2', null, t('title'))),
          h('div', { className: 'mr-alert', role: 'alert' }, `${t('loadFailed')}：${error}`),
          h('div', null, h('button', { type: 'button', onClick: () => { void load() } }, t('retry'))))
      }
      if (settings === undefined) {
        return h('div', { className: 'mr-root' }, h('style', null, CSS), h('p', { role: 'status' }, t('loading')))
      }

      /** Whether one tab's sections are the ones being rendered. */
      const shown = id => tab === id

      const exposure = settings.exposure
      const tierOnlyBlocked = exposure === 'tiers' && !anyDispatchable

      return h('div', { className: 'mr-root' },
        h('style', null, CSS),
        // Title and the save control share one row: the button belongs where a
        // reader looks for it, not below a long form. `intro` was deleted — a
        // paragraph describing what the page obviously does is noise.
        //
        // The button always says "Save". It does reload afterwards, but a label
        // that switches between "save" and "reload" made a single action look like
        // two states to keep track of, and the reload is not something the user
        // asked for — it is just how the page stays truthful.
        h('div', { className: 'mr-spread mr-page-head' },
          h('h2', null, t('title')),
          h('div', { className: 'mr-actions' },
            dirtyRef.current ? h('small', { className: 'mr-dirty' }, t('unsaved')) : null,
            h('button', {
              type: 'button', className: 'mr-primary', disabled: saving,
              onClick: () => { void save() },
            }, saving ? t('saving') : t('save')))),

        // Three tabs, because these are three different questions asked at
        // different times: what does my picker look like (配置), how should the
        // router behave (设置), and what actually happened on that turn (日志).
        h('div', { className: 'mr-tabs', role: 'tablist' },
          TABS.map(entry => h('button', {
            key: entry.id,
            type: 'button', role: 'tab', 'aria-selected': tab === entry.id,
            className: `mr-tab${tab === entry.id ? ' is-active' : ''}`,
            onClick: () => setTab(entry.id),
          }, t(entry.label)))),

        error === undefined ? null : h('div', { className: 'mr-alert', role: 'alert' }, error),
        notice === undefined ? null : h('p', { role: 'status', className: 'mr-note' }, notice),

        tab === 'log'
          ? h(LogPanel, { enabled: settings.logRequests !== false })
          : null,

        // ── tiers ──
        !shown('configure') ? null : h('section', { className: 'mr-card' },
          h('div', { className: 'mr-spread' },
            h('div', { className: 'mr-head', style: { gap: '4px' } },
              h('h3', null, t('tiers.title')),
              h('p', null, t('tiers.hint'))),
            h('button', {
              type: 'button',
              disabled: settings.tiers.length >= 24,
              onClick: () => {
                const name = lang() === 'zh' ? '新挡位' : 'New tier'
                const id = makeTierId(name, settings.tiers.map(tier => tier.id))
                // Inserted first, not last. A new tier appended below the fold
                // of a long list looked like the button did nothing; putting it
                // at the top also matches how the picker reads.
                setDraft(current => ({
                  ...current,
                  tiers: [{ id, name, enabled: true, order: 0, members: [] }, ...current.tiers],
                }))
              },
            }, `+ ${t('tiers.add')}`)),
          settings.tiers.length === 0
            ? h('div', { className: 'mr-empty' }, h('p', null, t('tiers.empty')))
            : settings.tiers.map((tier, index) => h(TierCard, {
              key: tier.id, tier, index, total: settings.tiers.length, catalog, probe,
              onChange: next => updateTier(index, next),
              onMove: delta => setDraft(current => ({ ...current, tiers: move(current.tiers, index, delta) })),
              onRemove: () => {
                if (!window.confirm(t('tiers.removeConfirm', { name: tier.name }))) return
                setDraft(current => ({ ...current, tiers: current.tiers.filter(candidate => candidate.id !== tier.id) }))
              },
              onAddMember: () => setPicker(tier.id),
            }))),

        // ── exposure ──
        !shown('settings') ? null : h('section', { className: 'mr-card' },
          h('h3', null, t('expose.title')),
          h('p', null, t('expose.hiding', { hidden: hiddenCounts.hidden, total: hiddenCounts.total })),
          tierOnlyBlocked ? h('div', { className: 'mr-note', role: 'status' }, t('expose.blocked')) : null,
          [['tiers', 'expose.tiers', 'expose.tiersHint'], ['custom', 'expose.custom', 'expose.customHint'], ['all', 'expose.all', 'expose.allHint']]
            .map(([value, label, hint]) => h('label', {
              key: value, className: `mr-radio${exposure === value ? ' is-active' : ''}`,
            },
            h('input', {
              type: 'radio', name: 'mr-exposure', checked: exposure === value,
              onChange: () => setDraft(current => ({ ...current, exposure: value })),
            }),
            h('span', { className: 'mr-radio-text' },
              h('span', { style: { fontSize: '13px' } }, t(label)),
              h('small', null, t(hint))))),
          exposure !== 'custom' ? null : h(Fragment, null,
            h('div', { className: 'mr-spread' },
              h('small', null, `${hiddenCounts.hidden} / ${hiddenCounts.total}`),
              h('div', { className: 'mr-actions' },
                h('button', {
                  type: 'button',
                  onClick: () => setDraft(current => ({
                    ...current,
                    hide: catalog.flatMap(group => [
                      { target: group.id, enabled: true },
                      ...group.models.map(model => ({ target: `${group.id}/${model.id}`, enabled: true })),
                    ]),
                  })),
                }, t('expose.hideAll')),
                h('button', {
                  type: 'button',
                  onClick: () => setDraft(current => ({ ...current, hide: current.hide.map(rule => ({ ...rule, enabled: false })) })),
                }, t('expose.hideNone')))),
            h('div', { className: 'mr-hide-grid' }, catalog.map(group => {
              const groupRule = (settings.hide ?? []).find(rule => rule.target === group.id)
              return h('div', { key: group.id, className: 'mr-hide-group' },
                h('label', null,
                  h('input', {
                    type: 'checkbox', checked: groupRule?.enabled === true,
                    onChange: event => setDraft(current => setHideRule(current, group.id, event.target.checked)),
                  }),
                  h('span', null, group.name ?? group.id)),
                group.models.map(model => {
                  const pair = `${group.id}/${model.id}`
                  const pairRule = (settings.hide ?? []).find(rule => rule.target === pair)
                  const covered = groupRule?.enabled === true
                  return h('label', { key: model.id, className: 'mr-hide-model', title: pair },
                    h('input', {
                      type: 'checkbox', checked: covered || pairRule?.enabled === true, disabled: covered,
                      onChange: event => setDraft(current => setHideRule(current, pair, event.target.checked)),
                    }),
                    h('span', null, model.name ?? model.id))
                }))
            })))),

        // ── advanced ──
        !shown('settings') ? null : h('section', { className: 'mr-card' },
          h('h3', null, t('options.title')),
          h('div', { className: 'mr-member-knobs' },
            h(Field, { label: t('options.timeout') },
              h(NumberInput, {
                value: toSeconds(settings.defaultIdleTimeoutMs), min: 0, max: MAX_TIMEOUT_SEC, unit: t('units.sec'),
                ariaLabel: t('options.timeout'),
                onChange: seconds => setDraft(current => ({ ...current, defaultIdleTimeoutMs: seconds === undefined ? 6_000 : fromSeconds(seconds) })),
              })),
            h(Field, { label: t('options.logLimit') },
              h(NumberInput, {
                value: settings.logLimit, min: 20, max: 2000, ariaLabel: t('options.logLimit'),
                onChange: limit => setDraft(current => ({ ...current, logLimit: limit === undefined ? 200 : Math.min(Math.max(limit, 20), 2000) })),
              }))),
          h('label', { className: 'mr-row' },
            h('input', {
              type: 'checkbox', checked: settings.showTierDescriptions !== false,
              onChange: event => setDraft(current => ({ ...current, showTierDescriptions: event.target.checked })),
            }),
            h('span', { style: { fontSize: '13px' } }, t('options.descriptions'))),
          h('label', { className: 'mr-row', title: t('options.modalityRoutingHint') },
            h('input', {
              type: 'checkbox', checked: settings.modalityRouting !== false,
              onChange: event => setDraft(current => ({ ...current, modalityRouting: event.target.checked })),
            }),
            h('span', { style: { fontSize: '13px' } }, t('options.modalityRouting')),
            h('small', null, t('options.modalityRoutingHint'))),
          h('label', { className: 'mr-row', title: t('options.effortMappingHint') },
            h('input', {
              type: 'checkbox', checked: settings.effortMapping !== false,
              onChange: event => setDraft(current => ({ ...current, effortMapping: event.target.checked })),
            }),
            h('span', { style: { fontSize: '13px' } }, t('options.effortMapping')),
            h('small', null, t('options.effortMappingHint'))),
          h(Field, { label: t('options.defaultEffort'), hint: t('options.defaultEffortHint') },
            h('select', {
              value: settings.defaultEffort ?? '', 'aria-label': t('options.defaultEffort'),
              onChange: event => setDraft(current => {
                const { defaultEffort: _drop, ...rest } = current
                return event.target.value === '' ? rest : { ...rest, defaultEffort: event.target.value }
              }),
            },
            h('option', { value: '' }, t('options.defaultEffortModel')),
            EFFORT_LADDER.map(id => h('option', { key: id, value: id }, id)))),
          h('label', { className: 'mr-row' },
            h('input', {
              type: 'checkbox', checked: settings.logRequests !== false,
              onChange: event => setDraft(current => ({ ...current, logRequests: event.target.checked })),
            }),
            h('span', { style: { fontSize: '13px' } }, t('options.logging'))),
          h('div', { className: 'mr-field' },
            h('span', null, t('options.file')),
            h('div', { className: 'mr-row' },
              h('code', { className: 'mr-code' }, state.file),
              h('button', {
                type: 'button',
                onClick: async () => {
                  try {
                    await navigator.clipboard.writeText(state.file)
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1_800)
                  } catch {
                    // Clipboard permission is the browser's call; the path is
                    // selectable text either way.
                  }
                },
              }, copied ? t('options.copied') : t('options.copy'))))),

        // ── preview ──
        // No heading: the tab is called 预览 and the only thing in it is the
        // preview, so a title saying "preview: what the picker shows" was a
        // heading restating its own container.
        //
        // Every provider keeps its own group. An earlier version flattened the
        // stock models into one "other models" bucket, which both lied about the
        // grouping the real picker uses and made the list unreadable.
        !shown('preview') ? null : h('section', { className: 'mr-card mr-preview-card' },
          h('div', { className: 'mr-preview' },
            h('div', { className: 'mr-preview-group' }, t('preview.tiers')),
            // Name only. The member count was a number with no action attached:
            // it did not tell you anything you could not see by opening the tier,
            // and repeating it on every row made the list look like a to-do list.
            settings.tiers.filter(tier => tier.enabled !== false).map(tier => h('div', { key: tier.id, className: 'mr-preview-row' },
              h('span', { className: 'mr-check' }, ''),
              h('span', null, tier.name))),
            exposure === 'tiers'
              ? h('p', { className: 'mr-preview-note' }, t('preview.hiddenAll'))
              : catalog.map(group => {
                // The same predicate the picker uses, so what is shown here is
                // what the menu will actually contain.
                const models = group.models.filter(model => !(settings.hide ?? []).some(rule => rule.enabled
                  && (rule.target === group.id || rule.target === `${group.id}/${model.id}`)))
                if (models.length === 0) return null
                return h('div', { key: group.id, className: 'mr-preview-block' },
                  h('div', { className: 'mr-preview-group' }, group.name ?? group.id),
                  models.map(model => h('div', { key: model.id, className: 'mr-preview-row' },
                    h('span', { className: 'mr-check' }, ''),
                    h('span', null, model.name ?? model.id))))
              }))),

        picker === undefined ? null : h(ModelPicker, {
          catalog: catalog.filter(group => group.id !== ROUTER_PROVIDER),
          taken: takenRoutes,
          onPick: route => {
            setDraft(current => ({
              ...current,
              tiers: current.tiers.map(tier => tier.id === picker
                ? {
                  ...tier,
                  members: [...tier.members, {
                    provider: route.provider,
                    model: route.model,
                    // A new member starts unset on both knobs, so it inherits the
                    // tier default and then the global one. Writing a number here
                    // would freeze today's default into the member forever.
                    enabled: true,
                  }],
                }
                : tier),
            }))
            setPicker(undefined)
            setProbe({})
            // Discover the new member's capabilities straight away: the tile shows
            // whether it resolves and whether it can see images, and a stale
            // "unknown" there is indistinguishable from a broken route.
            void runProbe(picker)
          },
          onClose: () => setPicker(undefined),
        }))
    }

    /** Set or clear one hide rule, keeping the list free of duplicates. */
    function setHideRule(settings, target, enabled) {
      const rules = (settings.hide ?? []).filter(rule => rule.target !== target)
      if (enabled) rules.push({ target, enabled: true })
      return { ...settings, hide: rules }
    }

    // ── plugin surface ──────────────────────────────────────────────────────

    const inject = ['slots']

    /** Mount the settings section. */
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'model-router',
        order: 26,
        label: () => t('nav'),
      }, RouterSettings))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'model-router'
    exports.__test = { DICT, CSS, TABS, EFFORT_LADDER, effortChoices, skipReasonKey, makeTierId, fromSeconds, toSeconds, move, setHideRule, parseTokens, formatTokens }
    return module.exports
  },
})
