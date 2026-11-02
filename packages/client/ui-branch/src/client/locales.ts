/** `branch` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'result.return': '回流到父分支',
  'result.preview': '将以下结论回流到父分支：',
  'result.confirm': '确认回流',
  'result.cancel': '取消',
  'result.retry': '重试回流',
  'result.failed': '回流失败，请重试',
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
} satisfies Record<BranchKey, string>

/** Japanese copy, checked against the zh key set. */
export const ja = {
  'result.return': '親ブランチへ戻す',
  'result.preview': 'この結論を親ブランチへ戻します：',
  'result.confirm': '戻すことを確認',
  'result.cancel': 'キャンセル',
  'result.retry': 'もう一度戻す',
  'result.failed': '戻せませんでした。もう一度お試しください',
} satisfies Record<BranchKey, string>

/** Spanish copy, checked against the zh key set. */
export const es = {
  'result.return': 'Devolver a la rama principal',
  'result.preview': 'Devolver esta conclusión a la rama principal:',
  'result.confirm': 'Confirmar devolución',
  'result.cancel': 'Cancelar',
  'result.retry': 'Reintentar devolución',
  'result.failed': 'No se pudo devolver; inténtalo de nuevo',
} satisfies Record<BranchKey, string>

/** French copy, checked against the zh key set. */
export const fr = {
  'result.return': 'Renvoyer vers la branche parente',
  'result.preview': 'Renvoyer cette conclusion vers la branche parente :',
  'result.confirm': 'Confirmer le renvoi',
  'result.cancel': 'Annuler',
  'result.retry': 'Réessayer le renvoi',
  'result.failed': 'Échec du renvoi ; réessayez',
} satisfies Record<BranchKey, string>

/** German copy, checked against the zh key set. */
export const de = {
  'result.return': 'An übergeordneten Branch zurückgeben',
  'result.preview': 'Dieses Ergebnis an den übergeordneten Branch zurückgeben:',
  'result.confirm': 'Rückgabe bestätigen',
  'result.cancel': 'Abbrechen',
  'result.retry': 'Rückgabe wiederholen',
  'result.failed': 'Rückgabe fehlgeschlagen; erneut versuchen',
} satisfies Record<BranchKey, string>

/** Russian copy, checked against the zh key set. */
export const ru = {
  'result.return': 'Вернуть в родительскую ветку',
  'result.preview': 'Вернуть этот вывод в родительскую ветку:',
  'result.confirm': 'Подтвердить возврат',
  'result.cancel': 'Отмена',
  'result.retry': 'Повторить возврат',
  'result.failed': 'Не удалось вернуть; повторите попытку',
} satisfies Record<BranchKey, string>

/** Portuguese copy, checked against the zh key set. */
export const pt = {
  'result.return': 'Devolver à ramificação principal',
  'result.preview': 'Devolver esta conclusão à ramificação principal:',
  'result.confirm': 'Confirmar devolução',
  'result.cancel': 'Cancelar',
  'result.retry': 'Tentar devolver novamente',
  'result.failed': 'Falha ao devolver; tente novamente',
} satisfies Record<BranchKey, string>
