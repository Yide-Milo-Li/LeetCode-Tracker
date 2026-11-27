/** Language cues for English/Chinese tracker labels. The model can answer in other languages. */
export function chatLanguageHint(text: string): 'zh' | 'en' | undefined {
  const prose = text
    .replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`|https?:\/\/\S+|《[^》]*》/g, ' ')
    .trim();
  // Match requests about the reply itself. “用英文变量名” only concerns code identifiers.
  const directives = /(?:使用|用|请以)\s*(中文|汉语|英文|英语|English|Chinese)(?=\s*(?:(?:简短|简要|详细)?(?:回答|回复|解释|说明|输出)|[，,。.!！?？]|$))|(中文|汉语|英文|英语)(?:回复|回答)|\b(?:reply|answer|respond|write) in (?:simplified )?(English|Chinese)\b/gi;
  let requested: 'zh' | 'en' | undefined;
  for (const match of prose.matchAll(directives)) {
    if (/(?:不要|别|不用|do not|don't|don't ever|never)\s*$/iu.test(prose.slice(0, match.index))) continue;
    const language = match[1] ?? match[2] ?? match[3];
    requested = /^(?:英文|英语|English)$/i.test(language) ? 'en' : 'zh';
  }
  if (requested) return requested;
  if (/\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(prose)) return;
  const han = prose.match(/\p{Script=Han}/gu)?.length ?? 0;
  // Function words distinguish an English request containing a Chinese title from a
  // Chinese request containing several English titles, tags or product names.
  const cues = prose.match(/\b(?:i|my|me|we|the|please|can|could|would|should|where|what|how|which|show|open|take|for|to|it|this|that|in|from|want|give|find|review|read|edit)\b/gi)?.length ?? 0;
  if (cues && cues * 2 > han) return 'en';
  if (han) return 'zh';
  return undefined;
}
