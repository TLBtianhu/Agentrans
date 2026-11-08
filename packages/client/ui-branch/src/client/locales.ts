/** `branch` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'result.return': '回流到父分支',
  'result.preview': '将以下结论回流到父分支：',
  'result.confirm': '确认回流',
  'result.cancel': '取消',
  'result.retry': '重试回流',
  'result.failed': '回流失败，请重试',
  'result.conflict': '此结论已通过不同证据回流。请打开父对话查看已采纳的内容。',
  'result.openParent': '打开父对话',
} satisfies Record<string, string>

/** Branch namespace key union. */
export type BranchKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'result.return': 'Return to parent branch',
  'result.preview': 'Return this conclusion to the parent branch:',
  'result.confirm': 'Confirm return',
  'result.cancel': 'Cancel',
  'result.retry': 'Retry return',
  'result.failed': 'Return failed; try again',
  'result.conflict': 'This conclusion was already returned with different evidence. Open the parent conversation to review it.',
  'result.openParent': 'Open parent conversation',
} satisfies Record<BranchKey, string>

/** Japanese copy, checked against the zh key set. */
export const ja = {
  'result.return': '親ブランチへ戻す',
  'result.preview': 'この結論を親ブランチへ戻します：',
  'result.confirm': '戻すことを確認',
  'result.cancel': 'キャンセル',
  'result.retry': 'もう一度戻す',
  'result.failed': '戻せませんでした。もう一度お試しください',
  'result.conflict': 'この結論は別の根拠とともに返されています。親の会話を開いて確認してください。',
  'result.openParent': '親の会話を開く',
} satisfies Record<BranchKey, string>

/** Spanish copy, checked against the zh key set. */
export const es = {
  'result.return': 'Devolver a la rama principal',
  'result.preview': 'Devolver esta conclusión a la rama principal:',
  'result.confirm': 'Confirmar devolución',
  'result.cancel': 'Cancelar',
  'result.retry': 'Reintentar devolución',
  'result.failed': 'No se pudo devolver; inténtalo de nuevo',
  'result.conflict': 'Esta conclusión ya se devolvió con otras pruebas. Abre la conversación principal para revisarla.',
  'result.openParent': 'Abrir conversación principal',
} satisfies Record<BranchKey, string>

/** French copy, checked against the zh key set. */
export const fr = {
  'result.return': 'Renvoyer vers la branche parente',
  'result.preview': 'Renvoyer cette conclusion vers la branche parente :',
  'result.confirm': 'Confirmer le renvoi',
  'result.cancel': 'Annuler',
  'result.retry': 'Réessayer le renvoi',
  'result.failed': 'Échec du renvoi ; réessayez',
  'result.conflict': 'Cette conclusion a déjà été renvoyée avec d’autres preuves. Ouvrez la conversation parente pour la consulter.',
  'result.openParent': 'Ouvrir la conversation parente',
} satisfies Record<BranchKey, string>

/** German copy, checked against the zh key set. */
export const de = {
  'result.return': 'An übergeordneten Branch zurückgeben',
  'result.preview': 'Dieses Ergebnis an den übergeordneten Branch zurückgeben:',
  'result.confirm': 'Rückgabe bestätigen',
  'result.cancel': 'Abbrechen',
  'result.retry': 'Rückgabe wiederholen',
  'result.failed': 'Rückgabe fehlgeschlagen; erneut versuchen',
  'result.conflict': 'Dieses Ergebnis wurde bereits mit anderen Belegen zurückgegeben. Öffnen Sie den übergeordneten Chat zur Prüfung.',
  'result.openParent': 'Übergeordneten Chat öffnen',
} satisfies Record<BranchKey, string>

/** Russian copy, checked against the zh key set. */
export const ru = {
  'result.return': 'Вернуть в родительскую ветку',
  'result.preview': 'Вернуть этот вывод в родительскую ветку:',
  'result.confirm': 'Подтвердить возврат',
  'result.cancel': 'Отмена',
  'result.retry': 'Повторить возврат',
  'result.failed': 'Не удалось вернуть; повторите попытку',
  'result.conflict': 'Этот вывод уже возвращён с другими доказательствами. Откройте родительскую беседу для проверки.',
  'result.openParent': 'Открыть родительскую беседу',
} satisfies Record<BranchKey, string>

/** Portuguese copy, checked against the zh key set. */
export const pt = {
  'result.return': 'Devolver à ramificação principal',
  'result.preview': 'Devolver esta conclusão à ramificação principal:',
  'result.confirm': 'Confirmar devolução',
  'result.cancel': 'Cancelar',
  'result.retry': 'Tentar devolver novamente',
  'result.failed': 'Falha ao devolver; tente novamente',
  'result.conflict': 'Esta conclusão já foi devolvida com outras evidências. Abra a conversa principal para conferir.',
  'result.openParent': 'Abrir conversa principal',
} satisfies Record<BranchKey, string>
