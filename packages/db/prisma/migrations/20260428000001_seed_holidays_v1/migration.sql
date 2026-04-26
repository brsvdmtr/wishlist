-- ═══════════════════════════════════════════════════════════════════════════
-- Holiday catalog seed (v1) — fixed-Gregorian-date holidays only
--   * RU (Russia)   → ru locale default
--   * US (USA)      → en locale default
--   * CN (China)    → zh-CN locale default (Gregorian only; lunar in v2)
--   * IN (India)    → hi locale default (Gregorian only; lunar/solar in v2)
--   * SA (Arab world generic — Saudi Arabia code) → ar locale default
--   * ES (Spain)    → es locale default
--
-- Idempotent via ON CONFLICT (key) DO NOTHING — safe to re-run.
-- All names are populated for all 6 locales for cross-locale fallback.
-- ═══════════════════════════════════════════════════════════════════════════

INSERT INTO "Holiday" ("id", "country", "month", "day", "key", "emoji", "category", "ordinal",
  "nameRu", "nameEn", "nameZhCn", "nameHi", "nameEs", "nameAr", "createdAt", "updatedAt") VALUES

-- ─── Russia (RU) ────────────────────────────────────────────────────────────
('hol_ru_new_year',   'RU',  1,  1, 'ru_new_year',          '🎄', 'NATIONAL', 1,
  'Новый год',                  'New Year (Russia)',         '俄罗斯新年',         'रूसी नव वर्ष',         'Año Nuevo (Rusia)',     'رأس السنة الميلادية (روسيا)', NOW(), NOW()),
('hol_ru_orthodox_xmas', 'RU', 1, 7, 'ru_orthodox_xmas',     '☦️', 'RELIGIOUS', 2,
  'Рождество Христово',         'Orthodox Christmas',        '东正教圣诞节',       'रूढ़िवादी क्रिसमस',     'Navidad Ortodoxa',      'عيد الميلاد الأرثوذكسي', NOW(), NOW()),
('hol_ru_defender',   'RU',  2, 23, 'ru_defender_day',      '🛡️', 'NATIONAL', 3,
  'День защитника Отечества',   'Defender of the Fatherland Day', '祖国保卫者日',  'पितृभूमि रक्षक दिवस', 'Día del Defensor de la Patria', 'يوم المدافع عن الوطن', NOW(), NOW()),
('hol_ru_womens_day', 'RU',  3,  8, 'ru_womens_day',        '🌷', 'INTERNATIONAL', 4,
  'Международный женский день', 'International Women''s Day', '国际妇女节',         'अंतर्राष्ट्रीय महिला दिवस', 'Día Internacional de la Mujer', 'اليوم العالمي للمرأة', NOW(), NOW()),
('hol_ru_labour_day', 'RU',  5,  1, 'ru_labour_day',        '🌹', 'NATIONAL', 5,
  'Праздник весны и труда',     'Spring and Labour Day',     '春节与劳动节',       'वसंत और श्रम दिवस',  'Día del Trabajo (Rusia)','عيد الربيع والعمل', NOW(), NOW()),
('hol_ru_victory_day','RU',  5,  9, 'ru_victory_day',       '🏅', 'NATIONAL', 6,
  'День Победы',                 'Victory Day (Russia)',      '胜利日',             'विजय दिवस',          'Día de la Victoria',    'يوم النصر', NOW(), NOW()),
('hol_ru_russia_day', 'RU',  6, 12, 'ru_russia_day',        '🇷🇺', 'NATIONAL', 7,
  'День России',                 'Russia Day',                '俄罗斯日',           'रूस दिवस',            'Día de Rusia',          'يوم روسيا', NOW(), NOW()),
('hol_ru_unity_day',  'RU', 11,  4, 'ru_unity_day',         '🤝', 'NATIONAL', 8,
  'День народного единства',    'Unity Day (Russia)',        '人民团结日',         'राष्ट्रीय एकता दिवस',  'Día de la Unidad Popular', 'يوم الوحدة الشعبية', NOW(), NOW()),
('hol_ru_nye',        'RU', 12, 31, 'ru_nye',               '🎄', 'NATIONAL', 9,
  'Новогодняя ночь',             'New Year''s Eve (Russia)',  '俄罗斯除夕',         'नववर्ष की पूर्व संध्या (रूस)', 'Nochevieja (Rusia)',     'ليلة رأس السنة (روسيا)', NOW(), NOW()),

-- ─── USA (US) ───────────────────────────────────────────────────────────────
('hol_us_new_year',   'US',  1,  1, 'us_new_year',          '🎉', 'NATIONAL', 1,
  'Новый год',                  'New Year''s Day',           '元旦',               'नव वर्ष दिवस',         'Año Nuevo',             'رأس السنة الميلادية', NOW(), NOW()),
('hol_us_valentine',  'US',  2, 14, 'us_valentine',         '💝', 'POPULAR', 2,
  'День святого Валентина',     'Valentine''s Day',          '情人节',             'वैलेंटाइन डे',         'Día de San Valentín',   'عيد الحب', NOW(), NOW()),
('hol_us_st_patrick', 'US',  3, 17, 'us_st_patrick',        '☘️', 'RELIGIOUS', 3,
  'День святого Патрика',       'St. Patrick''s Day',        '圣帕特里克节',       'सेंट पैट्रिक दिवस',    'Día de San Patricio',   'يوم القديس باتريك', NOW(), NOW()),
('hol_us_independence','US',  7,  4, 'us_independence',     '🇺🇸', 'NATIONAL', 4,
  'День независимости США',     'Independence Day',          '美国独立日',         'अमेरिकी स्वतंत्रता दिवस', 'Día de la Independencia (EE.UU.)', 'عيد الاستقلال الأمريكي', NOW(), NOW()),
('hol_us_halloween',  'US', 10, 31, 'us_halloween',         '🎃', 'POPULAR', 5,
  'Хэллоуин',                    'Halloween',                  '万圣节前夜',         'हैलोवीन',              'Halloween',             'عيد الهالوين', NOW(), NOW()),
('hol_us_veterans',   'US', 11, 11, 'us_veterans',          '🎖️', 'NATIONAL', 6,
  'День ветеранов',              'Veterans Day',              '退伍军人节',         'वेटरन्स डे',           'Día de los Veteranos',  'يوم المحاربين القدامى', NOW(), NOW()),
('hol_us_xmas_eve',   'US', 12, 24, 'us_xmas_eve',          '🎄', 'RELIGIOUS', 7,
  'Сочельник',                   'Christmas Eve',             '平安夜',             'क्रिसमस की पूर्व संध्या', 'Nochebuena',            'ليلة عيد الميلاد', NOW(), NOW()),
('hol_us_xmas',       'US', 12, 25, 'us_xmas',              '🎄', 'RELIGIOUS', 8,
  'Рождество',                   'Christmas Day',             '圣诞节',             'क्रिसमस',              'Navidad',               'عيد الميلاد', NOW(), NOW()),
('hol_us_nye',        'US', 12, 31, 'us_nye',               '🎉', 'NATIONAL', 9,
  'Канун Нового года',           'New Year''s Eve',           '除夕',               'नववर्ष की पूर्व संध्या', 'Nochevieja',            'ليلة رأس السنة', NOW(), NOW()),

-- ─── China (CN) ─────────────────────────────────────────────────────────────
('hol_cn_new_year',   'CN',  1,  1, 'cn_new_year',          '🎊', 'NATIONAL', 1,
  'Новый год (Китай)',           'New Year''s Day (China)',   '元旦',               'नव वर्ष (चीन)',       'Año Nuevo (China)',     'رأس السنة (الصين)', NOW(), NOW()),
('hol_cn_valentine',  'CN',  2, 14, 'cn_valentine',         '💝', 'POPULAR', 2,
  'День святого Валентина (Китай)','Valentine''s Day (China)','情人节',             'वैलेंटाइन डे (चीन)',  'Día de San Valentín (China)', 'عيد الحب (الصين)', NOW(), NOW()),
('hol_cn_womens_day', 'CN',  3,  8, 'cn_womens_day',        '🌷', 'INTERNATIONAL', 3,
  'Женский день',                'Women''s Day',              '妇女节',             'महिला दिवस',           'Día de la Mujer',       'يوم المرأة', NOW(), NOW()),
('hol_cn_qingming',   'CN',  4,  5, 'cn_qingming',          '🌸', 'NATIONAL', 4,
  'Цинмин',                       'Qingming Festival',         '清明节',             'चिंगमिंग',            'Festival Qingming',     'مهرجان تشينغمينغ', NOW(), NOW()),
('hol_cn_labour_day', 'CN',  5,  1, 'cn_labour_day',        '🏗️', 'NATIONAL', 5,
  'День труда (Китай)',          'Labour Day (China)',        '劳动节',             'श्रम दिवस (चीन)',     'Día del Trabajo (China)', 'عيد العمال (الصين)', NOW(), NOW()),
('hol_cn_youth_day',  'CN',  5,  4, 'cn_youth_day',         '🧑‍🎓', 'NATIONAL', 6,
  'День молодёжи',                'Youth Day',                  '青年节',             'युवा दिवस',           'Día de la Juventud',    'يوم الشباب', NOW(), NOW()),
('hol_cn_children',   'CN',  6,  1, 'cn_children_day',      '🧒', 'INTERNATIONAL', 7,
  'День защиты детей',           'Children''s Day',           '儿童节',             'बाल दिवस',             'Día del Niño',          'يوم الطفل', NOW(), NOW()),
('hol_cn_teachers',   'CN',  9, 10, 'cn_teachers_day',      '👩‍🏫', 'NATIONAL', 8,
  'День учителя',                 'Teachers'' Day',            '教师节',             'शिक्षक दिवस',          'Día del Maestro',       'يوم المعلم', NOW(), NOW()),
('hol_cn_national',   'CN', 10,  1, 'cn_national_day',      '🇨🇳', 'NATIONAL', 9,
  'День образования КНР',        'National Day (China)',      '国庆节',             'राष्ट्रीय दिवस (चीन)','Día Nacional (China)',  'العيد الوطني (الصين)', NOW(), NOW()),
('hol_cn_xmas',       'CN', 12, 25, 'cn_xmas',              '🎄', 'POPULAR', 10,
  'Рождество',                    'Christmas',                  '圣诞节',             'क्रिसमस',              'Navidad',               'عيد الميلاد', NOW(), NOW()),

-- ─── India (IN) ─────────────────────────────────────────────────────────────
('hol_in_new_year',   'IN',  1,  1, 'in_new_year',          '🎊', 'NATIONAL', 1,
  'Новый год',                    'New Year''s Day',           '元旦',               'नव वर्ष दिवस',         'Año Nuevo',             'رأس السنة', NOW(), NOW()),
('hol_in_republic',   'IN',  1, 26, 'in_republic_day',      '🇮🇳', 'NATIONAL', 2,
  'День Республики Индия',       'Republic Day (India)',      '印度共和国日',       'गणतंत्र दिवस',         'Día de la República (India)', 'يوم الجمهورية (الهند)', NOW(), NOW()),
('hol_in_valentine',  'IN',  2, 14, 'in_valentine',         '💝', 'POPULAR', 3,
  'День святого Валентина',      'Valentine''s Day',          '情人节',             'वैलेंटाइन डे',         'Día de San Valentín',   'عيد الحب', NOW(), NOW()),
('hol_in_holi_window','IN',  3,  8, 'in_holi_window',       '🎨', 'RELIGIOUS', 4,
  'Холи (примерно)',              'Holi (approx.)',            '洒红节（约）',       'होली (लगभग)',        'Holi (aprox.)',         'هولي (تقريباً)', NOW(), NOW()),
('hol_in_ambedkar',   'IN',  4, 14, 'in_ambedkar_jayanti',  '⚖️', 'NATIONAL', 5,
  'День Амбедкара',               'Ambedkar Jayanti',          '安贝德卡尔诞辰',     'अंबेडकर जयंती',       'Ambedkar Jayanti',      'أمبيدكار جايانتي', NOW(), NOW()),
('hol_in_labour_day', 'IN',  5,  1, 'in_labour_day',        '🌾', 'NATIONAL', 6,
  'День труда',                   'Labour Day (India)',        '劳动节',             'श्रम दिवस',             'Día del Trabajo',       'عيد العمال', NOW(), NOW()),
('hol_in_independence','IN', 8, 15, 'in_independence',      '🇮🇳', 'NATIONAL', 7,
  'День независимости Индии',    'Independence Day (India)',  '印度独立日',         'स्वतंत्रता दिवस',      'Día de la Independencia (India)', 'يوم الاستقلال (الهند)', NOW(), NOW()),
('hol_in_gandhi',     'IN', 10,  2, 'in_gandhi_jayanti',    '🕊️', 'NATIONAL', 8,
  'День рождения Ганди',         'Gandhi Jayanti',            '甘地诞辰',           'गांधी जयंती',          'Gandhi Jayanti',        'غاندي جايانتي', NOW(), NOW()),
('hol_in_diwali_window','IN',10, 24, 'in_diwali_window',    '🪔', 'RELIGIOUS', 9,
  'Дивали (примерно)',            'Diwali (approx.)',          '排灯节（约）',       'दिवाली (लगभग)',      'Diwali (aprox.)',       'ديوالي (تقريباً)', NOW(), NOW()),
('hol_in_xmas',       'IN', 12, 25, 'in_xmas',              '🎄', 'RELIGIOUS', 10,
  'Рождество',                    'Christmas',                  '圣诞节',             'क्रिसमस',              'Navidad',               'عيد الميلاد', NOW(), NOW()),

-- ─── Arab world generic (SA — Saudi Arabia code stands in for ar locale) ───
('hol_sa_new_year',   'SA',  1,  1, 'sa_new_year',          '🎉', 'NATIONAL', 1,
  'Новый год',                    'New Year''s Day',           '元旦',               'नव वर्ष दिवस',         'Año Nuevo',             'رأس السنة الميلادية', NOW(), NOW()),
('hol_sa_valentine',  'SA',  2, 14, 'sa_valentine',         '💝', 'POPULAR', 2,
  'День святого Валентина',      'Valentine''s Day',          '情人节',             'वैलेंटाइन डे',         'Día de San Valentín',   'عيد الحب', NOW(), NOW()),
('hol_sa_mothers',    'SA',  3, 21, 'sa_mothers_day',       '🌷', 'POPULAR', 3,
  'День матери (арабский мир)',  'Mother''s Day (Arab world)','母亲节（阿拉伯世界）','मातृ दिवस (अरब विश्व)','Día de la Madre (mundo árabe)', 'عيد الأم', NOW(), NOW()),
('hol_sa_labour_day', 'SA',  5,  1, 'sa_labour_day',        '🛠️', 'INTERNATIONAL', 4,
  'День труда',                   'Labour Day',                '劳动节',             'श्रम दिवस',             'Día del Trabajador',    'عيد العمال', NOW(), NOW()),
('hol_sa_national',   'SA',  9, 23, 'sa_national_day',      '🇸🇦', 'NATIONAL', 5,
  'Национальный день Саудовской Аравии', 'Saudi National Day','沙特国庆日',         'सऊदी राष्ट्रीय दिवस', 'Día Nacional de Arabia Saudí', 'اليوم الوطني السعودي', NOW(), NOW()),
('hol_sa_xmas_eve',   'SA', 12, 24, 'sa_xmas_eve',          '🎄', 'RELIGIOUS', 6,
  'Сочельник',                    'Christmas Eve',             '平安夜',             'क्रिसमस की पूर्व संध्या', 'Nochebuena',            'ليلة عيد الميلاد', NOW(), NOW()),
('hol_sa_xmas',       'SA', 12, 25, 'sa_xmas',              '🎄', 'RELIGIOUS', 7,
  'Рождество',                    'Christmas',                  '圣诞节',             'क्रिसमस',              'Navidad',               'عيد الميلاد', NOW(), NOW()),

-- ─── Spain (ES) ─────────────────────────────────────────────────────────────
('hol_es_new_year',   'ES',  1,  1, 'es_new_year',          '🎉', 'NATIONAL', 1,
  'Новый год',                    'New Year''s Day',           '元旦',               'नव वर्ष दिवस',         'Año Nuevo',             'رأس السنة الميلادية', NOW(), NOW()),
('hol_es_reyes',      'ES',  1,  6, 'es_reyes_magos',       '👑', 'RELIGIOUS', 2,
  'День Трёх королей',           'Three Kings Day',           '三王节',             'तीन राजाओं का दिन',   'Día de los Reyes Magos','يوم الملوك الثلاثة', NOW(), NOW()),
('hol_es_valentine',  'ES',  2, 14, 'es_valentine',         '💝', 'POPULAR', 3,
  'День святого Валентина',      'Valentine''s Day',          '情人节',             'वैलेंटाइन डे',         'Día de San Valentín',   'عيد الحب', NOW(), NOW()),
('hol_es_womens_day', 'ES',  3,  8, 'es_womens_day',        '🌷', 'INTERNATIONAL', 4,
  'Международный женский день', 'International Women''s Day', '国际妇女节',         'अंतर्राष्ट्रीय महिला दिवस', 'Día Internacional de la Mujer', 'اليوم العالمي للمرأة', NOW(), NOW()),
('hol_es_labour_day', 'ES',  5,  1, 'es_labour_day',        '🛠️', 'NATIONAL', 5,
  'День труда',                   'Labour Day',                '劳动节',             'श्रम दिवस',             'Día del Trabajador',    'عيد العمال', NOW(), NOW()),
('hol_es_hispanidad', 'ES', 10, 12, 'es_hispanidad',        '🇪🇸', 'NATIONAL', 6,
  'День Испанидад',               'National Day of Spain',     '西班牙国庆日',       'स्पेन का राष्ट्रीय दिवस', 'Día de la Hispanidad',   'اليوم الوطني لإسبانيا', NOW(), NOW()),
('hol_es_all_saints', 'ES', 11,  1, 'es_all_saints',        '🕯️', 'RELIGIOUS', 7,
  'День Всех Святых',             'All Saints'' Day',          '万圣节',             'सर्व संत दिवस',        'Día de Todos los Santos','عيد جميع القديسين', NOW(), NOW()),
('hol_es_xmas_eve',   'ES', 12, 24, 'es_xmas_eve',          '🎄', 'RELIGIOUS', 8,
  'Сочельник',                    'Christmas Eve',             '平安夜',             'क्रिसमस की पूर्व संध्या', 'Nochebuena',            'ليلة عيد الميلاد', NOW(), NOW()),
('hol_es_xmas',       'ES', 12, 25, 'es_xmas',              '🎄', 'RELIGIOUS', 9,
  'Рождество',                    'Christmas',                  '圣诞节',             'क्रिसमस',              'Navidad',               'عيد الميلاد', NOW(), NOW()),
('hol_es_nye',        'ES', 12, 31, 'es_nye',               '🎉', 'NATIONAL', 10,
  'Канун Нового года',            'New Year''s Eve',           '除夕',               'नववर्ष की पूर्व संध्या', 'Nochevieja',            'ليلة رأس السنة', NOW(), NOW())

ON CONFLICT ("key") DO NOTHING;
