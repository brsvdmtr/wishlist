// Secret Santa alias corpus + locale-aware renderer extracted from
// MiniApp.tsx — F5. Pure data + one pure formatter, no closures.
//
// The corpus mirrors the API's authoritative list — keys must match exactly
// (`adjectiveKey` / `animalKey` flow through API responses verbatim). On the
// API side the canonical source is `apps/api/src/services/santa-season.ts`.
//
// Locale rules implemented in `renderSantaAlias`:
//   ru / es: adjective agrees in gender with the animal
//   ar:      noun-first then adjective (also gendered)
//   zh-CN:   no space between adjective and noun
//   en / hi: adjective + space + animal

import { t, type Locale } from '@wishlist/shared';

/** Adjective corpus. Keyed by locale-independent key shared with the API. */
export const SANTA_ADJ: Record<string, { ru_m: string; ru_f: string; en: string; 'zh-CN': string; hi: string; es_m: string; es_f: string; ar_m: string; ar_f: string }> = {
  sleepy: { ru_m: 'Сонный', ru_f: 'Сонная', en: 'Sleepy', 'zh-CN': '瞌睡的', hi: 'नींद वाला', es_m: 'Soñoliento', es_f: 'Soñolienta', ar_m: 'نعسان', ar_f: 'نعسانة' },
  nimble: { ru_m: 'Ловкий', ru_f: 'Ловкая', en: 'Nimble', 'zh-CN': '敏捷的', hi: 'फुर्तीला', es_m: 'Ágil', es_f: 'Ágil', ar_m: 'رشيق', ar_f: 'رشيقة' },
  quiet: { ru_m: 'Тихий', ru_f: 'Тихая', en: 'Quiet', 'zh-CN': '安静的', hi: 'शांत', es_m: 'Silencioso', es_f: 'Silenciosa', ar_m: 'هادئ', ar_f: 'هادئة' },
  northern: { ru_m: 'Северный', ru_f: 'Северная', en: 'Northern', 'zh-CN': '北方的', hi: 'उत्तरी', es_m: 'Norteño', es_f: 'Norteña', ar_m: 'شمالي', ar_f: 'شمالية' },
  cheerful: { ru_m: 'Весёлый', ru_f: 'Весёлая', en: 'Cheerful', 'zh-CN': '快乐的', hi: 'खुशमिज़ाज', es_m: 'Alegre', es_f: 'Alegre', ar_m: 'مرح', ar_f: 'مرحة' },
  cunning: { ru_m: 'Хитрый', ru_f: 'Хитрая', en: 'Cunning', 'zh-CN': '狡黠的', hi: 'चालाक', es_m: 'Astuto', es_f: 'Astuta', ar_m: 'ماكر', ar_f: 'ماكرة' },
  kind: { ru_m: 'Добрый', ru_f: 'Добрая', en: 'Kind', 'zh-CN': '善良的', hi: 'दयालु', es_m: 'Bondadoso', es_f: 'Bondadosa', ar_m: 'طيب', ar_f: 'طيبة' },
  swift: { ru_m: 'Быстрый', ru_f: 'Быстрая', en: 'Swift', 'zh-CN': '迅捷的', hi: 'तेज़', es_m: 'Veloz', es_f: 'Veloz', ar_m: 'سريع', ar_f: 'سريعة' },
  brave: { ru_m: 'Смелый', ru_f: 'Смелая', en: 'Brave', 'zh-CN': '勇敢的', hi: 'बहादुर', es_m: 'Valiente', es_f: 'Valiente', ar_m: 'شجاع', ar_f: 'شجاعة' },
  smart: { ru_m: 'Умный', ru_f: 'Умная', en: 'Smart', 'zh-CN': '聪明的', hi: 'होशियार', es_m: 'Listo', es_f: 'Lista', ar_m: 'ذكي', ar_f: 'ذكية' },
  gentle: { ru_m: 'Нежный', ru_f: 'Нежная', en: 'Gentle', 'zh-CN': '温柔的', hi: 'कोमल', es_m: 'Tierno', es_f: 'Tierna', ar_m: 'لطيف', ar_f: 'لطيفة' },
  fluffy: { ru_m: 'Пушистый', ru_f: 'Пушистая', en: 'Fluffy', 'zh-CN': '蓬松的', hi: 'रोयेंदार', es_m: 'Mullido', es_f: 'Mullida', ar_m: 'زغبي', ar_f: 'زغبية' },
  bright: { ru_m: 'Яркий', ru_f: 'Яркая', en: 'Bright', 'zh-CN': '明亮的', hi: 'चमकीला', es_m: 'Brillante', es_f: 'Brillante', ar_m: 'ساطع', ar_f: 'ساطعة' },
  curious: { ru_m: 'Любопытный', ru_f: 'Любопытная', en: 'Curious', 'zh-CN': '好奇的', hi: 'जिज्ञासु', es_m: 'Curioso', es_f: 'Curiosa', ar_m: 'فضولي', ar_f: 'فضولية' },
  patient: { ru_m: 'Терпеливый', ru_f: 'Терпеливая', en: 'Patient', 'zh-CN': '耐心的', hi: 'धैर्यवान', es_m: 'Paciente', es_f: 'Paciente', ar_m: 'صبور', ar_f: 'صبورة' },
  playful: { ru_m: 'Игривый', ru_f: 'Игривая', en: 'Playful', 'zh-CN': '顽皮的', hi: 'खिलंदड़', es_m: 'Juguetón', es_f: 'Juguetona', ar_m: 'لعوب', ar_f: 'لعوبة' },
  cozy: { ru_m: 'Уютный', ru_f: 'Уютная', en: 'Cozy', 'zh-CN': '舒适的', hi: 'आरामदायक', es_m: 'Acogedor', es_f: 'Acogedora', ar_m: 'دافئ', ar_f: 'دافئة' },
  peaceful: { ru_m: 'Спокойный', ru_f: 'Спокойная', en: 'Peaceful', 'zh-CN': '平和的', hi: 'शांतिप्रिय', es_m: 'Apacible', es_f: 'Apacible', ar_m: 'وديع', ar_f: 'وديعة' },
  golden: { ru_m: 'Золотой', ru_f: 'Золотая', en: 'Golden', 'zh-CN': '金色的', hi: 'सुनहरा', es_m: 'Dorado', es_f: 'Dorada', ar_m: 'ذهبي', ar_f: 'ذهبية' },
  mysterious: { ru_m: 'Загадочный', ru_f: 'Загадочная', en: 'Mysterious', 'zh-CN': '神秘的', hi: 'रहस्यमय', es_m: 'Misterioso', es_f: 'Misteriosa', ar_m: 'غامض', ar_f: 'غامضة' },
  lucky: { ru_m: 'Удачливый', ru_f: 'Удачливая', en: 'Lucky', 'zh-CN': '幸运的', hi: 'भाग्यशाली', es_m: 'Afortunado', es_f: 'Afortunada', ar_m: 'محظوظ', ar_f: 'محظوظة' },
  energetic: { ru_m: 'Бодрый', ru_f: 'Бодрая', en: 'Energetic', 'zh-CN': '活力的', hi: 'ऊर्जावान', es_m: 'Enérgico', es_f: 'Enérgica', ar_m: 'نشيط', ar_f: 'نشيطة' },
  wise: { ru_m: 'Мудрый', ru_f: 'Мудрая', en: 'Wise', 'zh-CN': '睿智的', hi: 'बुद्धिमान', es_m: 'Sabio', es_f: 'Sabia', ar_m: 'حكيم', ar_f: 'حكيمة' },
  rare: { ru_m: 'Редкий', ru_f: 'Редкая', en: 'Rare', 'zh-CN': '稀有的', hi: 'दुर्लभ', es_m: 'Raro', es_f: 'Rara', ar_m: 'نادر', ar_f: 'نادرة' },
  honest: { ru_m: 'Честный', ru_f: 'Честная', en: 'Honest', 'zh-CN': '诚实的', hi: 'ईमानदार', es_m: 'Honesto', es_f: 'Honesta', ar_m: 'صادق', ar_f: 'صادقة' },
  courageous: { ru_m: 'Отважный', ru_f: 'Отважная', en: 'Courageous', 'zh-CN': '英勇的', hi: 'साहसी', es_m: 'Audaz', es_f: 'Audaz', ar_m: 'باسل', ar_f: 'باسلة' },
  modest: { ru_m: 'Скромный', ru_f: 'Скромная', en: 'Modest', 'zh-CN': '谦逊的', hi: 'विनम्र', es_m: 'Modesto', es_f: 'Modesta', ar_m: 'متواضع', ar_f: 'متواضعة' },
  wonderful: { ru_m: 'Чудесный', ru_f: 'Чудесная', en: 'Wonderful', 'zh-CN': '奇妙的', hi: 'अद्भुत', es_m: 'Maravilloso', es_f: 'Maravillosa', ar_m: 'رائع', ar_f: 'رائعة' },
  generous: { ru_m: 'Щедрый', ru_f: 'Щедрая', en: 'Generous', 'zh-CN': '慷慨的', hi: 'उदार', es_m: 'Generoso', es_f: 'Generosa', ar_m: 'كريم', ar_f: 'كريمة' },
  light: { ru_m: 'Лёгкий', ru_f: 'Лёгкая', en: 'Light', 'zh-CN': '轻盈的', hi: 'हल्का', es_m: 'Ligero', es_f: 'Ligera', ar_m: 'خفيف', ar_f: 'خفيفة' },
};

/** Animal corpus. Keyed by locale-independent key shared with the API. */
export const SANTA_ANIMAL: Record<string, { ru: string; gender: 'm' | 'f'; en: string; 'zh-CN': string; hi: string; es: string; ar: string }> = {
  giraffe: { ru: 'жираф', gender: 'm', en: 'Giraffe', 'zh-CN': '长颈鹿', hi: 'जिराफ़', es: 'Jirafa', ar: 'زرافة' },
  quokka: { ru: 'квокка', gender: 'f', en: 'Quokka', 'zh-CN': '短尾矮袋鼠', hi: 'क्वोक्का', es: 'Quokka', ar: 'كوكا' },
  manul: { ru: 'манул', gender: 'm', en: 'Pallas Cat', 'zh-CN': '兔狲', hi: 'मनुल', es: 'Gato manul', ar: 'قط مانول' },
  penguin: { ru: 'пингвин', gender: 'm', en: 'Penguin', 'zh-CN': '企鹅', hi: 'पेंगुइन', es: 'Pingüino', ar: 'بطريق' },
  fox: { ru: 'лиса', gender: 'f', en: 'Fox', 'zh-CN': '狐狸', hi: 'लोमड़ी', es: 'Zorra', ar: 'ثعلبة' },
  raccoon: { ru: 'енот', gender: 'm', en: 'Raccoon', 'zh-CN': '浣熊', hi: 'रैकून', es: 'Mapache', ar: 'راكون' },
  bear: { ru: 'медведь', gender: 'm', en: 'Bear', 'zh-CN': '熊', hi: 'भालू', es: 'Oso', ar: 'دب' },
  squirrel: { ru: 'белка', gender: 'f', en: 'Squirrel', 'zh-CN': '松鼠', hi: 'गिलहरी', es: 'Ardilla', ar: 'سنجاب' },
  hedgehog: { ru: 'ёж', gender: 'm', en: 'Hedgehog', 'zh-CN': '刺猬', hi: 'हेजहोग', es: 'Erizo', ar: 'قنفذ' },
  otter: { ru: 'выдра', gender: 'f', en: 'Otter', 'zh-CN': '水獭', hi: 'ऊदबिलाव', es: 'Nutria', ar: 'ثعلب الماء' },
  panda: { ru: 'панда', gender: 'f', en: 'Panda', 'zh-CN': '熊猫', hi: 'पांडा', es: 'Panda', ar: 'باندا' },
  koala: { ru: 'коала', gender: 'm', en: 'Koala', 'zh-CN': '考拉', hi: 'कोआला', es: 'Koala', ar: 'كوالا' },
  capybara: { ru: 'капибара', gender: 'f', en: 'Capybara', 'zh-CN': '水豚', hi: 'कैपीबारा', es: 'Capibara', ar: 'كابيبارا' },
  sloth: { ru: 'ленивец', gender: 'm', en: 'Sloth', 'zh-CN': '树懒', hi: 'स्लॉथ', es: 'Perezoso', ar: 'كسلان' },
  flamingo: { ru: 'фламинго', gender: 'm', en: 'Flamingo', 'zh-CN': '火烈鸟', hi: 'फ्लेमिंगो', es: 'Flamenco', ar: 'فلامنجو' },
  lemur: { ru: 'лемур', gender: 'm', en: 'Lemur', 'zh-CN': '狐猴', hi: 'लीमर', es: 'Lémur', ar: 'ليمور' },
  alpaca: { ru: 'альпака', gender: 'f', en: 'Alpaca', 'zh-CN': '羊驼', hi: 'अल्पाका', es: 'Alpaca', ar: 'ألبكة' },
  axolotl: { ru: 'аксолотль', gender: 'm', en: 'Axolotl', 'zh-CN': '蝾螈', hi: 'एक्सोलॉटल', es: 'Ajolote', ar: 'أكسولوتل' },
  narwhal: { ru: 'нарвал', gender: 'm', en: 'Narwhal', 'zh-CN': '独角鲸', hi: 'नरव्हेल', es: 'Narval', ar: 'نرول' },
  platypus: { ru: 'утконос', gender: 'm', en: 'Platypus', 'zh-CN': '鸭嘴兽', hi: 'प्लैटिपस', es: 'Ornitorrinco', ar: 'منقار البط' },
  meerkat: { ru: 'сурикат', gender: 'm', en: 'Meerkat', 'zh-CN': '猫鼬', hi: 'मीरकैट', es: 'Suricata', ar: 'نمس' },
  chinchilla: { ru: 'шиншилла', gender: 'f', en: 'Chinchilla', 'zh-CN': '毛丝鼠', hi: 'चिनचिला', es: 'Chinchilla', ar: 'شنشيلا' },
  tapir: { ru: 'тапир', gender: 'm', en: 'Tapir', 'zh-CN': '貘', hi: 'टपीर', es: 'Tapir', ar: 'تابير' },
  wombat: { ru: 'вомбат', gender: 'm', en: 'Wombat', 'zh-CN': '袋熊', hi: 'वोम्बैट', es: 'Wombat', ar: 'ومبت' },
  marmot: { ru: 'сурок', gender: 'm', en: 'Marmot', 'zh-CN': '土拨鼠', hi: 'मारमॉट', es: 'Marmota', ar: 'مرموط' },
  toucan: { ru: 'тукан', gender: 'm', en: 'Toucan', 'zh-CN': '巨嘴鸟', hi: 'टूकेन', es: 'Tucán', ar: 'طوقان' },
  armadillo: { ru: 'броненосец', gender: 'm', en: 'Armadillo', 'zh-CN': '犰狳', hi: 'आर्माडिलो', es: 'Armadillo', ar: 'أرماديللو' },
  cassowary: { ru: 'казуар', gender: 'm', en: 'Cassowary', 'zh-CN': '鹤鸵', hi: 'कैसोवरी', es: 'Casuario', ar: 'شبنم' },
  lynx: { ru: 'рысь', gender: 'f', en: 'Lynx', 'zh-CN': '猞猁', hi: 'लिंक्स', es: 'Lince', ar: 'وشق' },
  okapi: { ru: 'окапи', gender: 'm', en: 'Okapi', 'zh-CN': '霍加狓', hi: 'ओकापी', es: 'Okapi', ar: 'أوكابي' },
};

/**
 * Render alias in user's locale from adjectiveKey + animalKey.
 *
 * Falls back to `t('santa_participant_default', locale)` when either key is
 * unknown — which protects against API/FE corpus drift (a new key on the
 * API side that hasn't shipped to the client yet won't break rendering).
 */
export function renderSantaAlias(
  adjectiveKey: string,
  animalKey: string,
  locale: string,
): string {
  const adj = SANTA_ADJ[adjectiveKey];
  const animal = SANTA_ANIMAL[animalKey];
  if (!adj || !animal) return t('santa_participant_default', locale as Locale);
  switch (locale) {
    case 'en':    return `${adj.en} ${animal.en}`;
    case 'zh-CN': return `${adj['zh-CN']}${animal['zh-CN']}`;
    case 'hi':    return `${adj.hi} ${animal.hi}`;
    case 'es':    return `${animal.es} ${animal.gender === 'f' ? adj.es_f : adj.es_m}`;
    case 'ar':    return `${animal.ar} ${animal.gender === 'f' ? adj.ar_f : adj.ar_m}`;
    default:      return `${animal.gender === 'f' ? adj.ru_f : adj.ru_m} ${animal.ru}`;
  }
}
