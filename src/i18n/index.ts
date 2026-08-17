import { zhCN } from './locales/zh-CN';

export const locale = 'zh-CN' as const;
export type MessageKey = keyof typeof zhCN;
type MessageParams = Record<string, string | number>;

export function t(key: MessageKey, params: MessageParams = {}): string {
  return zhCN[key].replace(/\{(\w+)\}/g, (token, name: string) => (
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : token
  ));
}

const numberFormatter = new Intl.NumberFormat(locale);

export function formatNumber(value: number): string {
  return numberFormatter.format(value);
}
