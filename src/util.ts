/** 输出截断与 shell 引用（spec §3.1 / §4） */

export interface TruncateResult {
  text: string;
  truncated: boolean;
  originalBytes: number;
}

const MAX_BYTES = 100 * 1024; // 单方向上限 100KB

/** 头尾截断：超长保留头 60% + 尾 40%，中间标注原始字节数 */
export function truncateMiddle(text: string, maxBytes = MAX_BYTES): TruncateResult {
  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= maxBytes) return { text, truncated: false, originalBytes };
  // 近似按字节比例截字符（多字节场景略保守，可接受）
  const ratio = maxBytes / originalBytes;
  const keep = Math.floor(text.length * ratio);
  const head = text.slice(0, Math.floor(keep * 0.6));
  const tail = text.slice(-Math.floor(keep * 0.4));
  return {
    text: `${head}\n\n... [TRUNCATED ${originalBytes} bytes -> ${maxBytes}] ...\n\n${tail}`,
    truncated: true,
    originalBytes,
  };
}

/** shell 单引号安全包裹 */
export function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
