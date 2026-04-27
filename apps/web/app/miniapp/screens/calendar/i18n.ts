// Localized strings for the Events Calendar feature.
// 6 supported locales: ru | en | zh-CN | hi | es | ar.
//
// Falls back to en if a locale lacks a key.

import type { Locale } from '@wishlist/shared';

type StringMap = Record<Locale, string>;

const D: Record<string, StringMap> = {
  // ─── Common nav / chrome ───
  cal_title: {
    ru: 'События', en: 'Events', 'zh-CN': '事件', hi: 'इवेंट', es: 'Eventos', ar: 'الأحداث',
  },
  cal_today: {
    ru: 'Сегодня', en: 'Today', 'zh-CN': '今天', hi: 'आज', es: 'Hoy', ar: 'اليوم',
  },
  cal_back: {
    ru: 'Назад', en: 'Back', 'zh-CN': '返回', hi: 'वापस', es: 'Atrás', ar: 'رجوع',
  },
  cal_skip: {
    ru: 'Пропустить', en: 'Skip', 'zh-CN': '跳过', hi: 'छोड़ें', es: 'Omitir', ar: 'تخطٍ',
  },
  cal_next: {
    ru: 'Дальше', en: 'Next', 'zh-CN': '下一步', hi: 'अगला', es: 'Siguiente', ar: 'التالي',
  },
  cal_save: {
    ru: 'Сохранить', en: 'Save', 'zh-CN': '保存', hi: 'सहेजें', es: 'Guardar', ar: 'حفظ',
  },
  cal_cancel: {
    ru: 'Отмена', en: 'Cancel', 'zh-CN': '取消', hi: 'रद्द', es: 'Cancelar', ar: 'إلغاء',
  },
  cal_done: {
    ru: 'Готово', en: 'Done', 'zh-CN': '完成', hi: 'हो गया', es: 'Listo', ar: 'تم',
  },
  cal_share: {
    ru: 'Поделиться', en: 'Share', 'zh-CN': '分享', hi: 'साझा करें', es: 'Compartir', ar: 'مشاركة',
  },
  cal_delete: {
    ru: 'Удалить', en: 'Delete', 'zh-CN': '删除', hi: 'हटाएं', es: 'Eliminar', ar: 'حذف',
  },
  cal_edit: {
    ru: 'Изменить', en: 'Edit', 'zh-CN': '编辑', hi: 'संपादित', es: 'Editar', ar: 'تعديل',
  },
  cal_more: {
    ru: 'Ещё', en: 'More', 'zh-CN': '更多', hi: 'अधिक', es: 'Más', ar: 'المزيد',
  },

  // ─── View modes ───
  cal_view_month: { ru: 'Месяц', en: 'Month', 'zh-CN': '月', hi: 'महीना', es: 'Mes', ar: 'شهر' },
  cal_view_week:  { ru: 'Неделя', en: 'Week', 'zh-CN': '周', hi: 'सप्ताह', es: 'Semana', ar: 'أسبوع' },
  cal_view_list:  { ru: 'Список', en: 'List', 'zh-CN': '列表', hi: 'सूची', es: 'Lista', ar: 'قائمة' },
  cal_view_year:  { ru: 'Год', en: 'Year', 'zh-CN': '年', hi: 'वर्ष', es: 'Año', ar: 'سنة' },

  // ─── Filters ───
  cal_filter_birthdays: {
    ru: 'Дни рождения', en: 'Birthdays', 'zh-CN': '生日', hi: 'जन्मदिन', es: 'Cumpleaños', ar: 'أعياد ميلاد',
  },
  cal_filter_anniversaries: {
    ru: 'Годовщины', en: 'Anniversaries', 'zh-CN': '纪念日', hi: 'सालगिरह', es: 'Aniversarios', ar: 'ذكريات',
  },
  cal_filter_holidays: {
    ru: 'Праздники', en: 'Holidays', 'zh-CN': '节日', hi: 'त्यौहार', es: 'Festividades', ar: 'أعياد',
  },
  cal_filter_own: {
    ru: 'Свои', en: 'Own', 'zh-CN': '自己的', hi: 'अपने', es: 'Propios', ar: 'خاصة',
  },

  // ─── Empty state ───
  cal_empty_title: {
    ru: 'Календарь пуст', en: 'Calendar is empty', 'zh-CN': '日历为空', hi: 'कैलेंडर खाली है', es: 'Calendario vacío', ar: 'التقويم فارغ',
  },
  cal_empty_sub: {
    ru: 'Добавьте важную дату или импортируйте дни рождения друзей.',
    en: 'Add an important date or import friends’ birthdays.',
    'zh-CN': '添加重要日期或导入朋友的生日。',
    hi: 'एक महत्वपूर्ण तारीख जोड़ें या दोस्तों के जन्मदिन आयात करें।',
    es: 'Añade una fecha importante o importa los cumpleaños de tus amigos.',
    ar: 'أضف تاريخاً مهماً أو استورد أعياد ميلاد الأصدقاء.',
  },
  cal_empty_add_event: {
    ru: '＋ Добавить событие', en: '＋ Add event', 'zh-CN': '＋ 添加事件', hi: '＋ इवेंट जोड़ें', es: '＋ Añadir evento', ar: '＋ إضافة حدث',
  },
  cal_empty_import_friends: {
    ru: '↓ Импорт из друзей', en: '↓ Import from friends', 'zh-CN': '↓ 从朋友导入', hi: '↓ दोस्तों से आयात', es: '↓ Importar de amigos', ar: '↓ استيراد من الأصدقاء',
  },
  cal_empty_starter_ideas: {
    ru: 'Идеи для старта', en: 'Starter ideas', 'zh-CN': '入门建议', hi: 'शुरुआती आइडिया', es: 'Ideas iniciales', ar: 'أفكار للبداية',
  },

  // ─── Section headers ───
  cal_upcoming: {
    ru: 'Ближайшие события', en: 'Upcoming events', 'zh-CN': '即将到来的事件', hi: 'आगामी इवेंट', es: 'Próximos eventos', ar: 'الأحداث القادمة',
  },
  cal_no_upcoming: {
    ru: 'В ближайшее время событий нет',
    en: 'No upcoming events',
    'zh-CN': '近期没有事件',
    hi: 'कोई आगामी इवेंट नहीं',
    es: 'No hay eventos próximos',
    ar: 'لا أحداث قادمة',
  },

  // ─── Countdown helpers ───
  cal_today_label: { ru: 'сегодня', en: 'today', 'zh-CN': '今天', hi: 'आज', es: 'hoy', ar: 'اليوم' },
  cal_tomorrow_label: { ru: 'завтра', en: 'tomorrow', 'zh-CN': '明天', hi: 'कल', es: 'mañana', ar: 'غداً' },
  cal_in_days_one: {
    ru: 'через {n} день', en: 'in {n} day', 'zh-CN': '{n} 天后', hi: '{n} दिन में', es: 'en {n} día', ar: 'خلال {n} يوم',
  },
  cal_in_days_few: {
    ru: 'через {n} дня', en: 'in {n} days', 'zh-CN': '{n} 天后', hi: '{n} दिन में', es: 'en {n} días', ar: 'خلال {n} أيام',
  },
  cal_in_days_many: {
    ru: 'через {n} дн.', en: 'in {n} days', 'zh-CN': '{n} 天后', hi: '{n} दिन में', es: 'en {n} días', ar: 'خلال {n} يوماً',
  },
  cal_days_ago: {
    ru: '{n} дн назад', en: '{n} days ago', 'zh-CN': '{n} 天前', hi: '{n} दिन पहले', es: 'hace {n} días', ar: 'قبل {n} أيام',
  },

  // ─── Create wizard ───
  cal_create_step_label: { // "step X of 4"
    ru: 'шаг {n} из 4', en: 'step {n} of 4', 'zh-CN': '第 {n} / 4 步', hi: 'चरण {n} / 4', es: 'paso {n} de 4', ar: 'خطوة {n} من 4',
  },
  cal_create_title: {
    ru: 'Новое событие', en: 'New event', 'zh-CN': '新事件', hi: 'नया इवेंट', es: 'Nuevo evento', ar: 'حدث جديد',
  },
  cal_create_what: {
    ru: 'Что отмечаем?', en: 'What are you celebrating?', 'zh-CN': '我们在庆祝什么？', hi: 'हम क्या मना रहे हैं?', es: '¿Qué celebramos?', ar: 'بماذا نحتفل؟',
  },
  cal_type_birthday: {
    ru: 'День рождения', en: 'Birthday', 'zh-CN': '生日', hi: 'जन्मदिन', es: 'Cumpleaños', ar: 'عيد ميلاد',
  },
  cal_type_birthday_sub: {
    ru: 'Свой или чей-то', en: 'Yours or someone else’s', 'zh-CN': '自己或他人的', hi: 'अपना या किसी और का', es: 'Tuyo o de otra persona', ar: 'شخصي أو لشخص آخر',
  },
  cal_type_anniversary: {
    ru: 'Годовщина', en: 'Anniversary', 'zh-CN': '纪念日', hi: 'सालगिरह', es: 'Aniversario', ar: 'ذكرى',
  },
  cal_type_anniversary_sub: {
    ru: 'Свадьба, отношения', en: 'Wedding, relationship', 'zh-CN': '婚姻、关系', hi: 'शादी, रिश्ता', es: 'Boda, relación', ar: 'زواج، علاقة',
  },
  cal_type_holiday: {
    ru: 'Праздник', en: 'Holiday', 'zh-CN': '节日', hi: 'त्यौहार', es: 'Festividad', ar: 'عيد',
  },
  cal_type_holiday_sub: {
    ru: 'Из календаря', en: 'From calendar', 'zh-CN': '来自日历', hi: 'कैलेंडर से', es: 'Del calendario', ar: 'من التقويم',
  },
  cal_type_custom: {
    ru: 'Своё', en: 'Custom', 'zh-CN': '自定义', hi: 'अपना', es: 'Propio', ar: 'مخصص',
  },
  cal_type_custom_sub: {
    ru: 'Любая дата', en: 'Any date', 'zh-CN': '任意日期', hi: 'कोई भी तारीख', es: 'Cualquier fecha', ar: 'أي تاريخ',
  },
  cal_or_import: {
    ru: 'Или импортируйте', en: 'Or import', 'zh-CN': '或导入', hi: 'या आयात करें', es: 'O importar', ar: 'أو استيراد',
  },
  cal_import_friends: {
    ru: 'Из друзей WishBoard', en: 'From WishBoard friends', 'zh-CN': '从 WishBoard 好友', hi: 'WishBoard दोस्तों से', es: 'De amigos de WishBoard', ar: 'من أصدقاء WishBoard',
  },
  cal_import_friends_sub: {
    ru: '{n} дней рождения · в один клик',
    en: '{n} birthdays · one click',
    'zh-CN': '{n} 个生日 · 一键',
    hi: '{n} जन्मदिन · एक क्लिक',
    es: '{n} cumpleaños · un clic',
    ar: '{n} عيد ميلاد · بنقرة واحدة',
  },
  cal_import_country: {
    ru: 'Календарь страны', en: 'Country calendar', 'zh-CN': '国家日历', hi: 'देश का कैलेंडर', es: 'Calendario del país', ar: 'تقويم البلد',
  },
  cal_import_country_sub: {
    ru: '{n} праздников', en: '{n} holidays', 'zh-CN': '{n} 个节日', hi: '{n} त्यौहार', es: '{n} festividades', ar: '{n} أعياد',
  },
  cal_country_ru: { ru: 'Россия', en: 'Russia', 'zh-CN': '俄罗斯', hi: 'रूस', es: 'Rusia', ar: 'روسيا' },
  cal_country_us: { ru: 'США', en: 'USA', 'zh-CN': '美国', hi: 'अमेरिका', es: 'EE.UU.', ar: 'الولايات المتحدة' },
  cal_country_cn: { ru: 'Китай', en: 'China', 'zh-CN': '中国', hi: 'चीन', es: 'China', ar: 'الصين' },
  cal_country_in: { ru: 'Индия', en: 'India', 'zh-CN': '印度', hi: 'भारत', es: 'India', ar: 'الهند' },
  cal_country_sa: { ru: 'Арабский мир', en: 'Arab world', 'zh-CN': '阿拉伯世界', hi: 'अरब जगत', es: 'Mundo árabe', ar: 'العالم العربي' },
  cal_country_es: { ru: 'Испания', en: 'Spain', 'zh-CN': '西班牙', hi: 'स्पेन', es: 'España', ar: 'إسبانيا' },

  // ─── Form fields ───
  cal_field_name: { ru: 'Название', en: 'Name', 'zh-CN': '名称', hi: 'नाम', es: 'Nombre', ar: 'الاسم' },
  cal_field_emoji: { ru: 'Иконка', en: 'Icon', 'zh-CN': '图标', hi: 'आइकन', es: 'Icono', ar: 'الأيقونة' },
  cal_emoji_custom: { ru: 'Свой', en: 'Custom', 'zh-CN': '自定义', hi: 'अपना', es: 'Propio', ar: 'مخصص' },
  cal_emoji_custom_hint: {
    ru: 'Открой клавиатуру смайликов и выбери любой 👇',
    en: 'Open your emoji keyboard and pick any 👇',
    'zh-CN': '打开表情键盘并选择任意一个 👇',
    hi: 'अपना इमोजी कीबोर्ड खोलें और कोई भी चुनें 👇',
    es: 'Abre tu teclado de emojis y elige cualquiera 👇',
    ar: 'افتح لوحة الإيموجي واختر أي رمز 👇',
  },
  cal_emoji_custom_placeholder: {
    ru: 'Любой смайлик…', en: 'Any emoji…', 'zh-CN': '任意表情…', hi: 'कोई भी इमोजी…', es: 'Cualquier emoji…', ar: 'أي إيموجي…',
  },
  cal_emoji_back_to_palette: {
    ru: '← Назад к выбору', en: '← Back to palette', 'zh-CN': '← 返回选择', hi: '← पैलेट पर वापस', es: '← Volver a la paleta', ar: '← العودة إلى اللوحة',
  },
  cal_field_date: { ru: 'Дата', en: 'Date', 'zh-CN': '日期', hi: 'तारीख', es: 'Fecha', ar: 'التاريخ' },
  cal_pick_day: { ru: 'День', en: 'Day', 'zh-CN': '日', hi: 'दिन', es: 'Día', ar: 'اليوم' },
  cal_pick_month: { ru: 'Месяц', en: 'Month', 'zh-CN': '月', hi: 'महीना', es: 'Mes', ar: 'الشهر' },
  cal_pick_year: { ru: 'Год', en: 'Year', 'zh-CN': '年', hi: 'वर्ष', es: 'Año', ar: 'السنة' },
  cal_field_repeat: { ru: 'Повторение', en: 'Repeat', 'zh-CN': '重复', hi: 'दोहराव', es: 'Repetir', ar: 'التكرار' },
  cal_field_who: { ru: 'Кого поздравляем', en: 'Who to congratulate', 'zh-CN': '祝贺谁', hi: 'किसे बधाई', es: '¿A quién felicitar?', ar: 'من نهنئ' },
  cal_field_location: { ru: 'Место', en: 'Location', 'zh-CN': '地点', hi: 'स्थान', es: 'Lugar', ar: 'المكان' },
  cal_field_time: { ru: 'Время', en: 'Time', 'zh-CN': '时间', hi: 'समय', es: 'Hora', ar: 'الوقت' },
  cal_field_budget: { ru: 'Бюджет', en: 'Budget', 'zh-CN': '预算', hi: 'बजट', es: 'Presupuesto', ar: 'الميزانية' },
  cal_field_note: { ru: 'Заметка', en: 'Note', 'zh-CN': '备注', hi: 'नोट', es: 'Nota', ar: 'ملاحظة' },

  cal_recur_none: { ru: 'Однократно', en: 'Once', 'zh-CN': '一次', hi: 'एक बार', es: 'Una vez', ar: 'مرة واحدة' },
  cal_recur_yearly: { ru: 'Каждый год', en: 'Every year', 'zh-CN': '每年', hi: 'हर साल', es: 'Cada año', ar: 'كل سنة' },
  cal_recur_monthly: { ru: 'Каждый месяц', en: 'Every month', 'zh-CN': '每月', hi: 'हर महीने', es: 'Cada mes', ar: 'كل شهر' },

  // ─── Reminders step ───
  cal_reminders_when: {
    ru: 'Когда напомнить?', en: 'When to remind?', 'zh-CN': '何时提醒？', hi: 'कब याद दिलाएं?', es: '¿Cuándo recordar?', ar: 'متى نُذكِّر؟',
  },
  cal_reminder_2w: { ru: 'За 2 недели', en: '2 weeks before', 'zh-CN': '提前 2 周', hi: '2 हफ्ते पहले', es: '2 semanas antes', ar: 'قبل أسبوعين' },
  cal_reminder_1w: { ru: 'За неделю', en: '1 week before', 'zh-CN': '提前 1 周', hi: '1 हफ्ता पहले', es: '1 semana antes', ar: 'قبل أسبوع' },
  cal_reminder_3d: { ru: 'За 3 дня', en: '3 days before', 'zh-CN': '提前 3 天', hi: '3 दिन पहले', es: '3 días antes', ar: 'قبل 3 أيام' },
  cal_reminder_1d: { ru: 'Накануне', en: '1 day before', 'zh-CN': '前一天', hi: '1 दिन पहले', es: 'El día antes', ar: 'قبل يوم' },
  cal_reminder_0d: { ru: 'В день события', en: 'On the day', 'zh-CN': '当天', hi: 'इवेंट के दिन', es: 'El mismo día', ar: 'في اليوم نفسه' },

  // ─── Detail screen ───
  cal_when_label: { ru: 'Когда', en: 'When', 'zh-CN': '何时', hi: 'कब', es: 'Cuándo', ar: 'متى' },
  cal_who_label: { ru: 'Кого поздравляем', en: 'Who to greet', 'zh-CN': '祝贺谁', hi: 'किसे बधाई', es: 'A quién felicitar', ar: 'من نهنئ' },
  cal_repeat_label: { ru: 'Повторение', en: 'Repeat', 'zh-CN': '重复', hi: 'दोहराव', es: 'Repetir', ar: 'التكرار' },
  cal_reminders_label: { ru: 'Напоминания', en: 'Reminders', 'zh-CN': '提醒', hi: 'याद-दिलाने', es: 'Recordatorios', ar: 'التذكيرات' },
  cal_ideas_label: { ru: 'Идеи подарков', en: 'Gift ideas', 'zh-CN': '礼物想法', hi: 'उपहार आइडिया', es: 'Ideas de regalo', ar: 'أفكار هدايا' },
  cal_idea_add: {
    ru: 'Добавить идею', en: 'Add an idea', 'zh-CN': '添加想法', hi: 'आइडिया जोड़ें', es: 'Añadir idea', ar: 'إضافة فكرة',
  },
  cal_idea_placeholder: {
    ru: 'Например: книга «Думай быстро»',
    en: 'e.g. “Thinking, Fast and Slow”',
    'zh-CN': '例如：书《思考，快与慢》',
    hi: 'जैसे: किताब "Think Fast"',
    es: 'Ej.: libro «Pensar rápido»',
    ar: 'مثلاً: كتاب «التفكير السريع»',
  },
  cal_idea_link_placeholder: {
    ru: 'Ссылка (необязательно)',
    en: 'Link (optional)',
    'zh-CN': '链接（可选）',
    hi: 'लिंक (वैकल्पिक)',
    es: 'Enlace (opcional)',
    ar: 'رابط (اختياري)',
  },
  cal_idea_price_placeholder: {
    ru: 'Цена', en: 'Price', 'zh-CN': '价格', hi: 'मूल्य', es: 'Precio', ar: 'السعر',
  },
  cal_ideas_from_wishlist: {
    ru: 'Идеи · из вишлиста {name}',
    en: 'Ideas · from {name}’s wishlist',
    'zh-CN': '想法 · 来自 {name} 的心愿单',
    hi: 'आइडिया · {name} की विशलिस्ट से',
    es: 'Ideas · de la lista de {name}',
    ar: 'أفكار · من قائمة أمنيات {name}',
  },
  cal_open_wishlist: {
    ru: '↗ Открыть вишлист {name}',
    en: '↗ Open {name}’s wishlist',
    'zh-CN': '↗ 打开 {name} 的心愿单',
    hi: '↗ {name} की विशलिस्ट खोलें',
    es: '↗ Abrir lista de {name}',
    ar: '↗ فتح قائمة أمنيات {name}',
  },
  cal_mark_my_gift: {
    ru: 'Пометить — что подарю', en: 'Mark — what I’ll give', 'zh-CN': '标记 — 我送什么', hi: 'चिह्नित करें — मैं क्या दूंगा', es: 'Marcar — qué regalaré', ar: 'تحديد — ماذا سأهدي',
  },
  cal_pinned_today: { ru: 'Сегодня', en: 'Today', 'zh-CN': '今天', hi: 'आज', es: 'Hoy', ar: 'اليوم' },
  cal_pinned_past: {
    ru: '✓ Прошло', en: '✓ Past', 'zh-CN': '✓ 已过', hi: '✓ बीत गया', es: '✓ Pasado', ar: '✓ مضى',
  },
  cal_thank_you_title: { ru: 'Благодарность', en: 'Thank-you', 'zh-CN': '感谢', hi: 'धन्यवाद', es: 'Agradecimiento', ar: 'شكر' },
  cal_repeat_next_year: {
    ru: '⟲ Повторить в следующем году',
    en: '⟲ Repeat next year',
    'zh-CN': '⟲ 明年重复',
    hi: '⟲ अगले साल दोहराएं',
    es: '⟲ Repetir el próximo año',
    ar: '⟲ تكرار العام القادم',
  },

  // ─── Paywall ───
  cal_paywall_eyebrow: {
    ru: 'Подписка · единоразово', en: 'Subscription · one-time', 'zh-CN': '订阅 · 一次性', hi: 'सब्सक्रिप्शन · एक-बार', es: 'Suscripción · una vez', ar: 'اشتراك · لمرة واحدة',
  },
  cal_paywall_h1: {
    ru: 'Не забывайте о тех, кто важен',
    en: 'Don’t forget the ones who matter',
    'zh-CN': '别忘了重要的人',
    hi: 'जो ज़रूरी हैं उन्हें मत भूलें',
    es: 'No olvides a los que importan',
    ar: 'لا تنسَ من يهمك',
  },
  cal_paywall_sub: {
    ru: 'Подарочный календарь напомнит о днях рождения и подскажет, что подарить.',
    en: 'The Gift Calendar reminds you of birthdays and suggests what to give.',
    'zh-CN': '礼物日历会提醒生日并建议礼物。',
    hi: 'गिफ्ट कैलेंडर जन्मदिन याद दिलाता है और उपहार सुझाता है।',
    es: 'El Calendario de Regalos te recuerda cumpleaños y sugiere qué regalar.',
    ar: 'يذكّرك تقويم الهدايا بأعياد الميلاد ويقترح ماذا تهدي.',
  },
  cal_paywall_cta: {
    ru: 'Купить за {n} ⭐',
    en: 'Buy for {n} ⭐',
    'zh-CN': '购买 {n} ⭐',
    hi: '{n} ⭐ में खरीदें',
    es: 'Comprar por {n} ⭐',
    ar: 'شراء بـ {n} ⭐',
  },
  cal_paywall_demo_first: {
    ru: 'Сначала посмотреть демо',
    en: 'Try a demo first',
    'zh-CN': '先看演示',
    hi: 'पहले डेमो देखें',
    es: 'Probar demo primero',
    ar: 'جرّب العرض التجريبي أولاً',
  },
  cal_paywall_lock_title: {
    ru: 'Подарочный календарь',
    en: 'Gift Calendar',
    'zh-CN': '礼物日历',
    hi: 'गिफ्ट कैलेंडर',
    es: 'Calendario de Regalos',
    ar: 'تقويم الهدايا',
  },
  cal_paywall_lock_sub: {
    ru: 'Дни рождения, годовщины, праздники — в одном месте. С идеями подарков и напоминаниями.',
    en: 'Birthdays, anniversaries, holidays — all in one place. With gift ideas and reminders.',
    'zh-CN': '生日、纪念日、节日 — 一站式。配礼物建议和提醒。',
    hi: 'जन्मदिन, सालगिरह, त्यौहार — एक जगह। उपहार आइडिया और रिमाइंडर के साथ।',
    es: 'Cumpleaños, aniversarios y festividades en un solo lugar. Con ideas y recordatorios.',
    ar: 'أعياد الميلاد والذكريات والأعياد — في مكان واحد. مع أفكار هدايا وتذكيرات.',
  },
  cal_paywall_unlock: {
    ru: 'Разблокировать', en: 'Unlock', 'zh-CN': '解锁', hi: 'अनलॉक', es: 'Desbloquear', ar: 'إلغاء القفل',
  },
  cal_paywall_forever: {
    ru: '· навсегда', en: '· forever', 'zh-CN': '· 永久', hi: '· हमेशा', es: '· para siempre', ar: '· إلى الأبد',
  },

  // ─── Onboarding (4 steps) ───
  cal_onb1_h: {
    ru: 'Никогда не забывайте о важных датах',
    en: 'Never forget important dates',
    'zh-CN': '永远不会忘记重要的日子',
    hi: 'कभी भी ज़रूरी तारीखें न भूलें',
    es: 'No olvides nunca las fechas importantes',
    ar: 'لا تنسَ التواريخ المهمة أبداً',
  },
  cal_onb1_s: {
    ru: 'Дни рождения, годовщины, праздники — всё в одном календаре.',
    en: 'Birthdays, anniversaries, holidays — all in one calendar.',
    'zh-CN': '生日、纪念日、节日 — 全在一个日历。',
    hi: 'जन्मदिन, सालगिरह, त्यौहार — सब एक कैलेंडर में।',
    es: 'Cumpleaños, aniversarios y festividades en un solo calendario.',
    ar: 'أعياد الميلاد والذكريات والأعياد كلها في تقويم واحد.',
  },
  cal_onb2_h: {
    ru: 'Напомним заранее',
    en: 'We’ll remind you in advance',
    'zh-CN': '我们会提前提醒',
    hi: 'पहले से याद दिलाएंगे',
    es: 'Te lo recordaremos con antelación',
    ar: 'سنذكّرك مسبقاً',
  },
  cal_onb2_s: {
    ru: 'За 7, 3 и 1 день. Гибкая настройка для каждого события.',
    en: '7, 3 and 1 days before. Flexible per-event setup.',
    'zh-CN': '提前 7、3、1 天。每个事件可灵活设置。',
    hi: '7, 3 और 1 दिन पहले। हर इवेंट के लिए लचीली सेटिंग।',
    es: '7, 3 y 1 días antes. Configuración flexible por evento.',
    ar: 'قبل 7 و3 ويوم واحد. إعداد مرن لكل حدث.',
  },
  cal_onb3_h: {
    ru: 'Подскажем, что подарить',
    en: 'We’ll suggest what to give',
    'zh-CN': '我们会建议送什么',
    hi: 'हम सुझाव देंगे क्या उपहार दें',
    es: 'Sugerimos qué regalar',
    ar: 'سنقترح ماذا تهدي',
  },
  cal_onb3_s: {
    ru: 'Идеи из вишлиста человека или подборка под бюджет.',
    en: 'Ideas from the person’s wishlist or curated by budget.',
    'zh-CN': '来自对方心愿单或按预算精选。',
    hi: 'व्यक्ति की विशलिस्ट से या बजट के अनुसार।',
    es: 'Ideas de la lista del destinatario o curadas por presupuesto.',
    ar: 'أفكار من قائمة أمنيات الشخص أو مختارة حسب الميزانية.',
  },
  cal_onb4_h: {
    ru: 'Готово!', en: 'All set!', 'zh-CN': '准备就绪！', hi: 'सब तैयार!', es: '¡Listo!', ar: 'كل شيء جاهز!',
  },
  cal_onb4_s: {
    ru: 'Календарь подключён. Добавим ваше первое событие?',
    en: 'Calendar is on. Shall we add your first event?',
    'zh-CN': '日历已开启。要添加第一个事件吗？',
    hi: 'कैलेंडर चालू है। क्या पहला इवेंट जोड़ें?',
    es: 'El calendario está activo. ¿Añadimos tu primer evento?',
    ar: 'التقويم جاهز. هل نضيف حدثك الأول؟',
  },
  cal_onb_first_event: {
    ru: 'Добавить событие', en: 'Add event', 'zh-CN': '添加事件', hi: 'इवेंट जोड़ें', es: 'Añadir evento', ar: 'إضافة حدث',
  },
  cal_onb_later: {
    ru: 'Посмотреть позже', en: 'Look around first', 'zh-CN': '稍后再看', hi: 'बाद में देखें', es: 'Ver más tarde', ar: 'لاحقاً',
  },

  // ─── Inbox ───
  cal_inbox_title: { ru: 'Уведомления', en: 'Notifications', 'zh-CN': '通知', hi: 'सूचनाएं', es: 'Notificaciones', ar: 'الإشعارات' },
  cal_inbox_today: { ru: 'Сегодня', en: 'Today', 'zh-CN': '今天', hi: 'आज', es: 'Hoy', ar: 'اليوم' },
  cal_inbox_week: { ru: 'На этой неделе', en: 'This week', 'zh-CN': '本周', hi: 'इस हफ्ते', es: 'Esta semana', ar: 'هذا الأسبوع' },
  cal_inbox_archive: { ru: 'Архив', en: 'Archive', 'zh-CN': '归档', hi: 'पुरालेख', es: 'Archivo', ar: 'الأرشيف' },
  cal_inbox_empty: {
    ru: 'Пока нет уведомлений', en: 'No notifications yet', 'zh-CN': '暂无通知', hi: 'अभी तक कोई सूचना नहीं', es: 'Aún no hay notificaciones', ar: 'لا توجد إشعارات حتى الآن',
  },
  cal_inbox_mark_read: {
    ru: 'Отметить прочитанными', en: 'Mark all read', 'zh-CN': '全部标为已读', hi: 'सभी पढ़ी हुई', es: 'Marcar todo leído', ar: 'وضع علامة كمقروءة',
  },

  // ─── Year Recap ───
  cal_recap_eyebrow: {
    ru: '★ Ваш год в подарках',
    en: '★ Your year in gifts',
    'zh-CN': '★ 您送礼的一年',
    hi: '★ उपहारों में आपका साल',
    es: '★ Tu año en regalos',
    ar: '★ عامك في الهدايا',
  },
  cal_recap_sub: {
    ru: 'Спасибо, что не забывали о близких. Вот что у вас получилось ↓',
    en: 'Thanks for remembering loved ones. Here’s your year ↓',
    'zh-CN': '感谢您惦记亲友。这是您的一年 ↓',
    hi: 'अपनों को याद रखने के लिए धन्यवाद। यह रहा आपका साल ↓',
    es: 'Gracias por acordarte de los tuyos. Este es tu año ↓',
    ar: 'شكراً لتذكّر أحبائك. هذا عامك ↓',
  },
  cal_recap_gifts_given: {
    ru: 'Подарков подарено', en: 'Gifts given', 'zh-CN': '送出的礼物', hi: 'दिए गए उपहार', es: 'Regalos dados', ar: 'الهدايا المُقدَّمة',
  },
  cal_recap_birthdays: {
    ru: 'Дней рождения отмечено', en: 'Birthdays celebrated', 'zh-CN': '庆祝的生日', hi: 'जन्मदिन मनाए', es: 'Cumpleaños celebrados', ar: 'أعياد ميلاد احتُفل بها',
  },
  cal_recap_on_time: {
    ru: 'Не забыли вовремя', en: 'Remembered on time', 'zh-CN': '准时记得', hi: 'समय पर याद रखा', es: 'A tiempo', ar: 'تذكّرت في الوقت',
  },
  cal_recap_total_spent: {
    ru: 'Потрачено на подарки', en: 'Spent on gifts', 'zh-CN': '礼物花费', hi: 'उपहारों पर खर्च', es: 'Gastado en regalos', ar: 'أُنفقت على الهدايا',
  },
  cal_recap_avg: {
    ru: 'средний', en: 'average', 'zh-CN': '平均', hi: 'औसत', es: 'promedio', ar: 'المتوسط',
  },
  cal_recap_top: {
    ru: '«Самый внимательный»',
    en: '“Most thoughtful”',
    'zh-CN': '“最贴心”',
    hi: '“सबसे ध्यान रखने वाले”',
    es: '«Más atento»',
    ar: '«الأكثر اهتماماً»',
  },
  cal_recap_top_sub: {
    ru: 'Кому вы подарили чаще всего',
    en: 'Who you gifted to most',
    'zh-CN': '您送礼最多的人',
    hi: 'जिसे सबसे अधिक उपहार दिए',
    es: 'A quién regalaste más',
    ar: 'لمن أهديت أكثر',
  },
  cal_recap_share: {
    ru: '↗ Поделиться итогами',
    en: '↗ Share recap',
    'zh-CN': '↗ 分享回顾',
    hi: '↗ रिकैप साझा करें',
    es: '↗ Compartir resumen',
    ar: '↗ مشاركة الملخص',
  },

  // ─── Misc ───
  cal_unknown: { ru: 'Без названия', en: 'Untitled', 'zh-CN': '未命名', hi: 'बिना नाम', es: 'Sin título', ar: 'بدون عنوان' },
  cal_friend: { ru: 'Друг', en: 'Friend', 'zh-CN': '朋友', hi: 'दोस्त', es: 'Amigo', ar: 'صديق' },
  cal_create_success_title: {
    ru: 'Событие создано', en: 'Event created', 'zh-CN': '事件已创建', hi: 'इवेंट बना', es: 'Evento creado', ar: 'تم إنشاء الحدث',
  },
  cal_open_calendar: {
    ru: 'Открыть календарь', en: 'Open calendar', 'zh-CN': '打开日历', hi: 'कैलेंडर खोलें', es: 'Abrir calendario', ar: 'فتح التقويم',
  },
  cal_add_another: {
    ru: '＋ Добавить ещё', en: '＋ Add another', 'zh-CN': '＋ 再添加一个', hi: '＋ और जोड़ें', es: '＋ Añadir otro', ar: '＋ إضافة آخر',
  },
};

const FALLBACK_LOCALE: Locale = 'en';

/** Lookup a calendar string. Falls back to en, then to key itself. */
export function ct(key: keyof typeof D | string, locale: Locale, vars?: Record<string, string | number>): string {
  const entry = (D as Record<string, StringMap>)[key];
  if (!entry) return key;
  let s = entry[locale] ?? entry[FALLBACK_LOCALE] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
    }
  }
  return s;
}

/** Russian-style plural form picker for 1 / 2-4 / 5+. Other locales use generic plural. */
export function ctDays(n: number, locale: Locale): string {
  if (n === 0) return ct('cal_today_label', locale);
  if (n === 1) return ct('cal_tomorrow_label', locale);
  if (locale === 'ru') {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return ct('cal_in_days_one', locale, { n });
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return ct('cal_in_days_few', locale, { n });
    return ct('cal_in_days_many', locale, { n });
  }
  return ct('cal_in_days_many', locale, { n });
}

export function ctDaysAgo(n: number, locale: Locale): string {
  return ct('cal_days_ago', locale, { n });
}

export const CAL_PRICE_XTR = 19; // mirrors GIFT_NOTES_PRICE_XTR
