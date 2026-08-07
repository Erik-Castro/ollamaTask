export interface NowResult {
  iso: string;
  unix: number;
  timezone: string;
  utcOffsetMinutes: number;
}

/**
 * Retorna a data/hora atual de forma estruturada: { iso, unix, timezone,
 * utcOffsetMinutes }. Sem permissões especiais.
 */
export const Now = (): NowResult => {
  const date = new Date();
  return {
    iso: date.toISOString(),
    unix: Math.floor(date.getTime() / 1000),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    utcOffsetMinutes: -date.getTimezoneOffset(),
  };
};
