/** `artifact` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'card.label': 'Artifact：{title}',
  'revision': '版本 {revision}',
  'preview.frame': '{title} 预览',
  'source.label': 'HTML 源码',
  'view.source': '查看源码',
  'view.preview': '显示预览',
  'view.focus': '展开 Artifact',
  'view.inline': '使用内联视图',
  'pending.action': '操作：{action}',
  'pending.more': '{count} 个操作待发送',
  'pending.overflow': '待发送操作已满，请先发送现有操作',
  'send.action': '发送给 Agent',
  'send.sending': '正在发送…',
  'send.retry': '重试发送给 Agent',
  'send.failed': '操作未能发送，请重试',
} satisfies Record<string, string>

/** Artifact namespace key union. */
export type ArtifactKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'card.label': 'Artifact: {title}',
  'revision': 'Revision {revision}',
  'preview.frame': '{title} preview',
  'source.label': 'HTML source',
  'view.source': 'View source',
  'view.preview': 'Show preview',
  'view.focus': 'Expand artifact',
  'view.inline': 'Use inline view',
  'pending.action': 'Action: {action}',
  'pending.more': '{count} actions pending',
  'pending.overflow': 'The pending action queue is full. Send an existing action first.',
  'send.action': 'Send to Agent',
  'send.sending': 'Sending…',
  'send.retry': 'Retry sending to Agent',
  'send.failed': 'The action could not be sent. Try again.',
} satisfies Record<ArtifactKey, string>

/** Japanese dictionary, checked against the English keys. */
export const ja = {
  'card.label': 'Artifact: {title}',
  'revision': 'リビジョン {revision}',
  'preview.frame': '{title} のプレビュー',
  'source.label': 'HTML ソース',
  'view.source': 'ソースを表示',
  'view.preview': 'プレビューを表示',
  'view.focus': 'Artifact を展開',
  'view.inline': 'インライン表示に戻す',
  'pending.action': 'アクション: {action}',
  'pending.more': '{count} 件のアクションが保留中',
  'pending.overflow': '保留中のアクションが上限に達しました。既存のアクションを先に送信してください。',
  'send.action': 'Agent に送信',
  'send.sending': '送信中…',
  'send.retry': 'Agent への送信を再試行',
  'send.failed': 'アクションを送信できませんでした。もう一度お試しください。',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'card.label': 'Artifact: {title}',
  'revision': 'Revisión {revision}',
  'preview.frame': 'Vista previa de {title}',
  'source.label': 'Código fuente HTML',
  'view.source': 'Ver código fuente',
  'view.preview': 'Mostrar vista previa',
  'view.focus': 'Expandir artifact',
  'view.inline': 'Usar vista en línea',
  'pending.action': 'Acción: {action}',
  'pending.more': '{count} acciones pendientes',
  'pending.overflow': 'La cola de acciones pendientes está llena. Envía primero una acción existente.',
  'send.action': 'Enviar al Agent',
  'send.sending': 'Enviando…',
  'send.retry': 'Reintentar envío al Agent',
  'send.failed': 'No se pudo enviar la acción. Inténtalo de nuevo.',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'card.label': 'Artifact : {title}',
  'revision': 'Révision {revision}',
  'preview.frame': 'Aperçu de {title}',
  'source.label': 'Source HTML',
  'view.source': 'Voir la source',
  'view.preview': 'Afficher l’aperçu',
  'view.focus': 'Développer l’artifact',
  'view.inline': 'Utiliser la vue intégrée',
  'pending.action': 'Action : {action}',
  'pending.more': '{count} actions en attente',
  'pending.overflow': 'La file d’actions en attente est pleine. Envoyez d’abord une action existante.',
  'send.action': 'Envoyer à l’Agent',
  'send.sending': 'Envoi…',
  'send.retry': 'Réessayer l’envoi à l’Agent',
  'send.failed': 'L’action n’a pas pu être envoyée. Réessayez.',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'card.label': 'Artifact: {title}',
  'revision': 'Revision {revision}',
  'preview.frame': '{title}-Vorschau',
  'source.label': 'HTML-Quelltext',
  'view.source': 'Quelltext anzeigen',
  'view.preview': 'Vorschau anzeigen',
  'view.focus': 'Artifact erweitern',
  'view.inline': 'Inline-Ansicht verwenden',
  'pending.action': 'Aktion: {action}',
  'pending.more': '{count} Aktionen ausstehend',
  'pending.overflow': 'Die Warteschlange ist voll. Sende zuerst eine vorhandene Aktion.',
  'send.action': 'An Agent senden',
  'send.sending': 'Wird gesendet…',
  'send.retry': 'Senden an Agent erneut versuchen',
  'send.failed': 'Die Aktion konnte nicht gesendet werden. Versuche es erneut.',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'card.label': 'Artifact: {title}',
  'revision': 'Ревизия {revision}',
  'preview.frame': 'Предпросмотр: {title}',
  'source.label': 'Исходный код HTML',
  'view.source': 'Показать исходный код',
  'view.preview': 'Показать предпросмотр',
  'view.focus': 'Развернуть Artifact',
  'view.inline': 'Использовать встроенный вид',
  'pending.action': 'Действие: {action}',
  'pending.more': 'Ожидают действий: {count}',
  'pending.overflow': 'Очередь действий заполнена. Сначала отправьте существующее действие.',
  'send.action': 'Отправить Agent',
  'send.sending': 'Отправка…',
  'send.retry': 'Повторить отправку Agent',
  'send.failed': 'Не удалось отправить действие. Повторите попытку.',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'card.label': 'Artifact: {title}',
  'revision': 'Revisão {revision}',
  'preview.frame': 'Pré-visualização de {title}',
  'source.label': 'Código-fonte HTML',
  'view.source': 'Ver código-fonte',
  'view.preview': 'Mostrar pré-visualização',
  'view.focus': 'Expandir artifact',
  'view.inline': 'Usar visualização embutida',
  'pending.action': 'Ação: {action}',
  'pending.more': '{count} ações pendentes',
  'pending.overflow': 'A fila de ações pendentes está cheia. Envie primeiro uma ação existente.',
  'send.action': 'Enviar ao Agent',
  'send.sending': 'Enviando…',
  'send.retry': 'Tentar enviar ao Agent novamente',
  'send.failed': 'Não foi possível enviar a ação. Tente novamente.',
} satisfies Record<keyof typeof en, string>
