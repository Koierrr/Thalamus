// interest.js — 兴趣与口头禅的长期演化（一周结算一次，取决于性格与职业）
// 设计（用户拍板）：
//   · 节奏：跟性格周结算同一个节拍（满 7 天才允许动一次）
//   · 变不变、变成什么：由性格决定倾向（发起力高+秩序感低=爱尝新；温度高=口头禅变软；
//     锐度高=吐槽系；依恋高+关系近=更亲密的说法），由职业/生活提供素材方向
//   · 保底：兴趣 ≥3 个、口头禅 ≥2 个；上限：兴趣 ≤8、口头禅 ≤5
//   · 记录：**她自己换的留历史**（写进 world-state.log，后台可看"什么时候换的、为什么"）；
//           **用户手改的不留历史**（直接覆盖，不进 log）

export const INTEREST_MIN = 3;
export const INTEREST_MAX = 8;
export const PHRASE_MIN = 2;
export const PHRASE_MAX = 5;

/** 变化倾向（0~1）：性格 + 关系阶段决定"她这周有多想变" */
export function changeTendency(traits = {}, stageMin = 0) {
  const g = (k, d = 50) => (traits[k] == null ? d : Number(traits[k]));
  // 兴趣：发起力（爱尝试新东西）× 低秩序感（习惯不固化）
  const interest = Math.max(0.05, Math.min(0.95,
    (0.25 + (g('initiative') / 100) * 0.55) * (1.25 - (g('orderliness') / 100) * 0.7)));
  // 口头禅：温度/依恋让说法变软、锐度让说法变冲；关系越近越容易改口
  const phrase = Math.max(0.05, Math.min(0.95,
    (0.2 + (g('warmth') / 100) * 0.35 + (g('sharpness') / 100) * 0.25) + (stageMin >= 55 ? 0.15 : 0)));
  const why = '发起力' + Math.round(g('initiative')) + '／秩序感' + Math.round(g('orderliness'))
    + ' → 兴趣变化倾向 ' + Math.round(interest * 100) + '%；'
    + '温度' + Math.round(g('warmth')) + '／锐度' + Math.round(g('sharpness')) + '／关系阶段' + (stageMin >= 55 ? '已较近' : '还较远')
    + ' → 口头禅变化倾向 ' + Math.round(phrase * 100) + '%';
  return { interest: Math.round(interest * 100) / 100, phrase: Math.round(phrase * 100) / 100, why };
}

const clean = (s, max = 12) => String(s == null ? '' : s).replace(/\s+/g, '').slice(0, max);
const uniq = (arr) => [...new Set(arr.map((x) => clean(x)).filter(Boolean))];

/**
 * 把世界引擎给的变化建议落到人设上（可能一个都不落）。
 * @returns {{applied:object, tendency:object, notes:string[]}}
 */
export function applyInterestChanges({ persona = {}, traits = {}, stageMin = 0, suggestion = {}, roll = Math.random } = {}) {
  const tend = changeTendency(traits, stageMin);
  const notes = [];
  const cur = {
    interests: uniq(Array.isArray(persona.interests) ? persona.interests : []).slice(0, INTEREST_MAX),
    phrases: uniq(Array.isArray((persona.quirks || {}).catchphrases) ? persona.quirks.catchphrases : []).slice(0, PHRASE_MAX),
  };
  const before = { interests: [...cur.interests], phrases: [...cur.phrases] };
  const log = [];

  const addOne = (kind, list, text, reason, min, max, prob) => {
    const v = clean(text);
    if (!v || list.includes(v)) return false;
    if (roll() > prob) { notes.push('（本周' + kind + '本可以加「' + v + '」，但按性格倾向这次没加）'); return false; }
    if (list.length >= max) list.shift(); // 满了就淡出最早的
    list.push(v);
    log.push({ at: Date.now(), kind, op: 'add', text: v, reason: String(reason || '').slice(0, 80) });
    notes.push(kind + ' +「' + v + '」' + (reason ? '（' + reason + '）' : ''));
    return true;
  };
  const dropOne = (kind, list, text, reason, min, prob) => {
    const v = clean(text);
    const i = v ? list.indexOf(v) : -1;
    if (i < 0) return false;
    if (list.length <= min) { notes.push('（想淡出「' + v + '」，但' + kind + '已经只剩 ' + min + ' 个保底了）'); return false; }
    if (roll() > prob) { notes.push('（想淡出「' + v + '」但按性格倾向这次没淡出）'); return false; }
    list.splice(i, 1);
    log.push({ at: Date.now(), kind, op: 'drop', text: v, reason: String(reason || '').slice(0, 80) });
    notes.push(kind + ' −「' + v + '」' + (reason ? '（' + reason + '）' : ''));
    return true;
  };

  const iReason = suggestion.interestsReason || '';
  const pReason = suggestion.phraseReason || '';
  addOne('兴趣', cur.interests, suggestion.interestsAdd, iReason, INTEREST_MIN, INTEREST_MAX, tend.interest);
  if (suggestion.interestDrop) dropOne('兴趣', cur.interests, suggestion.interestDrop, iReason, INTEREST_MIN, tend.interest);
  addOne('口头禅', cur.phrases, suggestion.phraseAdd, pReason, PHRASE_MIN, PHRASE_MAX, tend.phrase);
  if (suggestion.phraseDrop) dropOne('口头禅', cur.phrases, suggestion.phraseDrop, pReason, PHRASE_MIN, tend.phrase);

  const changed = JSON.stringify(before) !== JSON.stringify({ interests: cur.interests, phrases: cur.phrases });
  return {
    changed,
    tendency: tend,
    notes,
    interests: cur.interests,
    phrases: cur.phrases,
    log,
    before,
  };
}

/** 用户手动改：直接覆盖，**不留历史**（用户拍板：他自己换的才留） */
export function manualReplacement(persona = {}) {
  return {
    interests: uniq(Array.isArray(persona.interests) ? persona.interests : []).slice(0, INTEREST_MAX),
    phrases: uniq(Array.isArray((persona.quirks || {}).catchphrases) ? persona.quirks.catchphrases : []).slice(0, PHRASE_MAX),
  };
}
