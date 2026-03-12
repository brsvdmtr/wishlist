// ─── Locale type ─────────────────────────────────────────────────────────────

export type Locale = 'ru' | 'en';

// ─── Locale detection ────────────────────────────────────────────────────────

/**
 * Detect locale from a Telegram language_code string.
 * Returns 'ru' only for Russian; everything else falls back to 'en'.
 */
export function detectLocale(languageCode?: string): Locale {
  if (languageCode === 'ru') return 'ru';
  return 'en';
}

// ─── Dictionaries ────────────────────────────────────────────────────────────

type Dict = Record<string, string>;

const ru: Dict = {
  // ── General / Common ──────────────────────────────────────────────────────
  loading: 'Загрузка…',
  error_generic: 'Что-то пошло не так',
  error_network: 'Ошибка сети',
  cancel: 'Отмена',
  save: 'Сохранить',
  done: 'Готово',
  back: 'Назад',
  delete: 'Удалить',
  close: 'Закрыть',
  retry: 'Повторить',
  copy: 'Копировать',
  open: 'Открыть',

  // ── Error screen ──────────────────────────────────────────────────────────
  error_open_in_telegram: 'Открой в Telegram',
  error_loading: 'Ошибка загрузки',
  error_unknown: 'Неизвестная ошибка',
  error_telegram_only: 'Это приложение работает только внутри Telegram',
  error_load_failed: 'Не удалось загрузить. Попробуй ещё раз.',
  error_open_in_telegram_btn: 'Открыть в Telegram',

  // ── My Wishlists screen ───────────────────────────────────────────────────
  greeting: 'Привет, {{name}}!',
  my_wishlists: 'Мои вишлисты',
  stats_total: 'Всего',
  stats_wishlists: 'вишлиста',
  stats_wishes: 'желаний',
  stats_reserved: 'забронировано',
  empty_state_title: 'Пока пусто',
  empty_state_subtitle: 'Создай первый вишлист и поделись с друзьями!',
  plan_status: '{{plan}}: {{count}} из {{max}} вишлистов',
  create_wishlist_btn: '＋ Создать вишлист',
  connect_pro: 'Подключить Pro',
  wishlist_count: '{{count}} желаний • {{reserved}} забронировано',
  view_only: 'Только просмотр',

  // ── Drafts ────────────────────────────────────────────────────────────────
  drafts_title: 'Неразобранное',
  drafts_empty: 'Пусто',
  drafts_empty_hint: 'Отправь ссылку на товар в чат с ботом или вставь ссылку выше',
  drafts_send_link: 'Отправь ссылку на товар боту',
  drafts_move: 'Переместить',
  drafts_archive: 'В архив',
  drafts_open: 'Открыть ›',
  drafts_url_placeholder: 'Вставь ссылку на товар…',
  drafts_url_pro_placeholder: 'Ссылка на товар · Pro',
  drafts_archived_toast: 'Перенесено в архив. Восстановить можно в течение 90 дней.',
  drafts_card_created: 'Карточка создана!',
  drafts_move_title: 'Переместить в вишлист',
  drafts_create_first: 'Сначала создай вишлист',
  drafts_moved: 'Перемещено в «{{name}}»',

  // ── Reservations ──────────────────────────────────────────────────────────
  reservations_title: 'Забронировано мной',
  reservations_empty_title: 'Пока пусто',
  reservations_empty_hint: 'Здесь появятся желания, которые ты забронируешь у друзей',
  reservations_loading: 'Загружаем…',
  reservations_open_list: 'Открыть список',
  reservations_unreserve: 'Снять бронь',
  reservations_reserved: 'Забронировано',

  // ── Wishlist detail ───────────────────────────────────────────────────────
  wishes_count: '{{count}} желаний',
  archive_btn: 'Архив',
  share_btn: 'Поделиться',
  read_only_notice: 'Только просмотр — лимит Free.',
  read_only_upgrade: 'Подключи Pro',
  read_only_to_edit: ', чтобы редактировать.',
  surprise_notice: 'Ты не видишь, кто и что забронировал — сюрприз!',
  add_first_wish: 'Добавь первое желание',
  add_first_wish_hint: 'Что бы ты хотел получить в подарок?',
  add_wish_btn: '＋ Добавить желание',

  // ── Item detail (owner) ───────────────────────────────────────────────────
  description_title: 'Описание',
  description_edit: 'Изменить',
  description_add_prompt: 'Добавь описание, чтобы друзьям было проще выбрать подарок',
  description_add_btn: '+ Добавить',
  description_placeholder: 'Опиши подробнее, что хочешь...',
  description_saved: 'Описание сохранено',
  edit_btn: '✏️ Редактировать',
  received_btn: 'Получено ✓',
  delete_btn: 'Удалить',
  status_someone_reserved: 'Кто-то выбрал этот подарок ✨',
  status_gifted: '✅ Подарено',

  // ── Item detail (guest) ───────────────────────────────────────────────────
  reserve_btn: '🎁 Забронировать',
  reserved_by_me: '✅ Забронировано мной',
  cancel_reservation: 'Отменить бронь',
  already_reserved: 'Уже забронировано',
  after_reserve_hint: 'После бронирования можно оставить комментарий для автора',

  // ── Reserve bottom sheet ──────────────────────────────────────────────────
  reserve_title: 'Забронировать подарок?',
  reserve_name_label: 'Твоё имя (видят другие гости)',
  reserve_name_placeholder: 'Как тебя зовут?',
  reserve_privacy: '🔒 Владелец вишлиста <b>не увидит</b>, кто какой подарок забронировал.',
  reserve_success: '🎁 Забронировано!',
  unreserve_success: 'Бронь отменена',

  // ── Comments ──────────────────────────────────────────────────────────────
  comments_title: 'Комментарии',
  comments_subtitle: 'Личный чат между автором и тем, кто забронировал',
  comments_archive_warning: 'Комментарии будут удалены через 30 дней',
  comments_empty: 'Напишите первое сообщение',
  comments_placeholder: 'Написать комментарий...',
  comments_anon: 'Аноним',
  comments_me: 'Я',
  comments_pro_title: 'Комментарии',
  comments_pro_hint: 'Обсуждай детали подарков с тем, кто забронировал',
  comments_pro_more: 'Подробнее →',
  comments_max_chars: 'Максимум 300 символов',
  comments_write_something: 'Напиши что-нибудь содержательное',
  comments_send_error: 'Ошибка отправки',
  comments_delete_error: 'Ошибка удаления',

  // ── Hints ─────────────────────────────────────────────────────────────────
  hint_friends_btn: 'Намекнуть друзьям',
  hint_subtitle: 'Аккуратно подскажи о своих желаниях',
  hint_reserved_notice: 'На это желание намекать уже не нужно — его забронировали',
  hint_closing: 'Передаю в бот...',
  hint_limit_exhausted: 'Лимит исчерпан.',

  // ── Hint formatRetryAfter ─────────────────────────────────────────────────
  retry_now: 'Попробуйте снова.',
  retry_minutes: 'Попробуйте через {{minutes}} мин.',
  retry_hours: 'Попробуйте через {{hours}} ч {{minutes}} мин.',
  retry_hours_only: 'Попробуйте через {{hours}} ч.',
  retry_tomorrow: 'Попробуйте завтра в {{time}}.',

  // ── Create wishlist form ──────────────────────────────────────────────────
  new_wishlist: 'Новый вишлист',
  wishlist_name: 'Название',
  wishlist_name_placeholder: 'Например: День рождения 2026 🎂',
  wishlist_deadline: 'Дедлайн (необязательно)',
  wishlist_create_btn: '✨ Создать',
  wishlist_created: '✅ Вишлист создан!',

  // ── Rename wishlist ───────────────────────────────────────────────────────
  rename_title: 'Переименовать вишлист',
  rename_placeholder: 'Название вишлиста',
  rename_success: 'Название обновлено',

  // ── Item form ─────────────────────────────────────────────────────────────
  item_form_edit: 'Редактировать',
  item_form_new: 'Новое желание',
  item_name: 'Название',
  item_name_placeholder: 'Например: AirPods Pro 3',
  item_description: 'Описание (необязательно)',
  item_description_placeholder: 'Подробности о желании...',
  item_url: 'Ссылка (необязательно)',
  item_photo: 'Фото',
  item_photo_select: 'Выбрать фото',
  item_photo_replace: 'Заменить фото',
  item_photo_delete: 'Удалить фото',
  item_photo_uploading: 'Загружаю...',
  item_photo_error: 'Ошибка загрузки фото',
  item_photo_network_error: 'Ошибка сети при загрузке фото',
  item_photo_only_images: 'Только изображения (JPEG, PNG, WebP, GIF)',
  item_photo_too_large: 'Файл слишком большой. Максимум 30 МБ',
  item_price: 'Цена (необязательно)',
  item_priority: 'Приоритет',
  item_saved: '✅ Сохранено!',
  item_added: '✅ Желание добавлено!',
  item_add_btn: '✨ Добавить',

  // ── Priority labels ───────────────────────────────────────────────────────
  priority_low: 'Неплохо',
  priority_low_sub: 'Низкий приоритет',
  priority_medium: 'Хочу',
  priority_medium_sub: 'Средний приоритет',
  priority_high: 'Мечтаю',
  priority_high_sub: 'Высокий приоритет',

  // ── Delete confirmation ───────────────────────────────────────────────────
  delete_title: 'Удалить желание?',
  delete_deleted: '🗑 Удалено',

  // ── Archive ───────────────────────────────────────────────────────────────
  archive_title: 'Архив',
  archive_retention: 'Архивные желания хранятся 90 дней',
  archive_empty: 'Архив пуст',
  archive_empty_hint: 'Удалённые и полученные желания появятся здесь',
  archive_received: 'Получено',
  archive_deleted: 'Удалено',
  archive_restore: '↩ Восстановить',
  archive_restored: 'Восстановлено!',
  archive_received_toast: 'Получено!',

  // ── Settings ──────────────────────────────────────────────────────────────
  settings_title: 'Настройки',
  settings_plan: 'Тариф',
  settings_wishlists: 'Вишлисты',
  settings_wishes_each: 'Желаний в каждом',
  settings_participants: 'Участников',
  settings_comments: 'Комментарии',
  settings_url_import: 'Добавление по ссылке',
  settings_hints: 'Намекнуть на подарок',
  settings_next_renewal: 'Следующее продление',
  settings_renewal_disabled: 'Продление отключено. Pro до',
  settings_cancel_renewal: 'Отменить продление',
  settings_resume_sub: 'Возобновить подписку',
  settings_resuming: 'Обновляем…',
  settings_god_mode: '⚡ Режим бога',
  settings_god_active: 'PRO без подписки, лимиты сняты',
  settings_god_inactive: 'Виртуальный PRO для тестирования',
  settings_up_to: 'до {{n}}',

  // ── Settings - PRO benefit descriptions ───────────────────────────────────
  settings_desc_wishlists: 'Разделяй по событиям и людям',
  settings_desc_wishes: 'Больше места для хотелок',
  settings_desc_participants: 'Собирай близких в одном вишлисте',
  settings_desc_comments: 'Обсуждай подарок прямо в карточке',
  settings_desc_url_import: 'Бот сам заполнит карточку по ссылке',
  settings_desc_hints: 'Подскажи друзьям конкретную идею',

  // ── Cancel subscription ───────────────────────────────────────────────────
  cancel_title: 'Отменить продление?',
  cancel_notice: 'Pro останется до',
  cancel_after: 'После этого тариф сменится на Free.',
  cancel_btn: 'Отменить продление',
  cancel_cancelling: 'Отменяем…',
  cancel_keep: 'Оставить Pro',
  cancel_success: 'Продление отключено',

  // ── Pro Upsell ────────────────────────────────────────────────────────────
  upsell_checkout_loading: 'Оформляем…',
  upsell_cta: 'Подключить Pro',
  upsell_not_now: 'Не сейчас',
  upsell_auto_renew: 'Автопродление · отменить можно в любой момент',
  upsell_per_month: '/ мес',
  upsell_comments_title: 'Комментарии к подаркам',
  upsell_comments_subtitle: 'Обсуждай детали с тем, кто забронировал — прямо в карточке.',
  upsell_comments_b1: 'Приватный чат с бронирующим',
  upsell_comments_b2: 'Уточни размер, цвет и детали',
  upsell_comments_b3: 'Вся история в одном месте',
  upsell_url_title: 'Добавление по ссылке',
  upsell_url_subtitle:
    'Просто отправь ссылку боту — он сам подтянет название, фото и цену. Останется только перенести в нужный вишлист.',
  upsell_url_b1: 'Автозаполнение карточки по ссылке',
  upsell_url_b2: 'Поддержка популярных магазинов',
  upsell_url_b3: 'Добавление желания в два клика',
  upsell_hints_title: 'Намекнуть на подарок',
  upsell_hints_subtitle: 'Аккуратно подскажи друзьям, что именно ты хочешь получить — без неловкости.',
  upsell_hints_b1: 'Мягкая подсказка для друзей',
  upsell_hints_b2: 'Ссылка на конкретное желание',
  upsell_hints_b3: 'Без неловких разговоров о подарках',
  upsell_wl_title: 'Нужно больше вишлистов?',
  upsell_wl_subtitle: 'На бесплатном тарифе — 2 вишлиста. С Pro — до 10.',
  upsell_item_title: 'Лимит желаний достигнут',
  upsell_item_subtitle: 'Бесплатно — до 30 в вишлисте. С Pro — до 100.',
  upsell_part_title: 'Слишком много участников',
  upsell_part_subtitle: 'Бесплатно — до 5 участников. С Pro — до 20.',

  // ── Comparison table labels ───────────────────────────────────────────────
  table_wishlists: 'Вишлисты',
  table_wishes: 'Желания',
  table_participants: 'Участников',
  table_comments: 'Комментарии',
  table_by_link: 'По ссылке',
  table_hints: 'Намёки',

  // ── Share screen ──────────────────────────────────────────────────────────
  share_title: 'Поделиться',
  share_link_error: 'Не удалось создать ссылку. Попробуй позже.',
  share_copied: '📨 Ссылка скопирована',
  share_tg_btn: '✈️ Поделиться в Telegram',
  share_copy_btn: '📋 Скопировать ссылку',
  share_privacy:
    '🔒 Друзья увидят список, но не узнают, кто что забронировал. Ты тоже не увидишь детали — сюрприз!',
  share_text: '🎁 {{title}}\nВыбирай подарок тут 👇',

  // ── Price filters ─────────────────────────────────────────────────────────
  filter_all: 'Все',
  filter_under_3k: 'До 3 000 ₽',
  filter_under_10k: 'До 10 000 ₽',
  filter_under_25k: 'До 25 000 ₽',

  // ── Toasts / errors ───────────────────────────────────────────────────────
  toast_plan_limit: 'Достигнут лимит тарифа',
  toast_url_error: 'Не удалось обработать ссылку',
  toast_url_import_error: 'Ошибка при обработке ссылки',
  toast_move_error: 'Не удалось переместить',
  toast_move_error_generic: 'Ошибка при перемещении',
  toast_error_generic: 'Ошибка',
  toast_create_error: 'Ошибка создания',
  toast_save_error: 'Ошибка сохранения',
  toast_add_error: 'Ошибка добавления',
  toast_delete_error: 'Ошибка удаления',
  toast_restore_error: 'Ошибка восстановления',
  toast_load_error: 'Ошибка загрузки',
  toast_archive_error: 'Ошибка загрузки архива',
  toast_already_reserved: 'Уже забронировано',
  toast_max_participants: 'В этом вишлисте уже максимум участников',
  toast_already_pro: 'У тебя уже есть Pro ✨',
  toast_checkout_error: 'Не удалось начать оформление',
  toast_update_telegram: 'Обнови Telegram для оплаты',
  toast_pro_activated: 'Pro подключён! ✨',
  toast_payment_syncing: 'Оплата прошла! Данные обновятся через пару секунд',
  toast_payment_failed: 'Оплата не прошла',
  toast_cancel_error: 'Не удалось отменить',
  toast_renewal_resumed: 'Продление возобновлено ✨',
  toast_renewing_new: 'Оформляем новую подписку…',
  toast_god_toggle_error: 'Не удалось переключить',
  toast_max_wishlists: 'Максимум {{n}} вишлистов на Pro',
  toast_max_items: 'Максимум {{n}} желаний на Pro',
  toast_profile_coming: 'Профиль появится в следующих версиях',
  link_label: '🔗 ссылка',

  // ── Plural helpers (Russian declension) ───────────────────────────────────
  cards_one: 'карточка',
  cards_few: 'карточки',
  cards_many: 'карточек',
  wishes_one: 'желание',
  wishes_few: 'желания',
  wishes_many: 'желаний',

  // ── Bot strings ───────────────────────────────────────────────────────────
  bot_menu_btn: 'Вишлист',
  bot_start:
    'Привет! WishBoard — твой персональный список желаний 🎁\nНажми кнопку «Вишлист» внизу, чтобы открыть приложение.',
  bot_help:
    'WishBoard — создавай вишлисты и делись ими с друзьями.\n\n/start — начать\n/paysupport — помощь с оплатой\n\nОтправь ссылку на товар — я создам карточку желания!',
  bot_paysupport:
    '💳 Помощь с оплатой\n\nЕсли у тебя возникли проблемы с оплатой или подпиской PRO:\n\n1. Убедись, что у тебя достаточно Telegram Stars\n2. Попробуй перезапустить приложение и повторить оплату\n3. Если проблема сохраняется — напиши описание проблемы в этот чат, мы разберёмся 🙏',
  bot_view_wishlist: 'Смотри вишлист 🎁',
  bot_view_wishlist_btn: 'Смотреть вишлист 🎁',
  bot_hint_unavailable: 'Это желание больше не доступно 🤷',
  bot_hint_self: 'Себе намек отправлять не нужно 😊',
  bot_hint_reserved: 'На это желание уже не нужно намекать — оно забронировано 🎁',
  bot_hint_msg:
    'Есть идея подарка для {{owner}} 🎁\n\nОбрати внимание на желание «{{title}}» — похоже, {{shortName}} особенно нравится это.',
  bot_hint_view_btn: 'Посмотреть желание 🎁',
  bot_error: 'Произошла ошибка. Попробуй позже 🙈',
  bot_users_shared_no_profile: 'Не удалось найти профиль. Открой приложение и попробуй снова.',
  bot_users_shared_no_hint: 'Активный намёк не найден. Создай новый в приложении.',
  bot_users_shared_reserved: 'Это желание уже забронировано — намёк больше не нужен 🎁',
  bot_sent_count: '✅ Отправлено напрямую: {{n}}',
  bot_pending_count: '⏳ Не удалось отправить: {{n}} (нет диалога с ботом)',
  bot_no_recipients: 'Не выбран ни один получатель.',
  bot_fallback_msg:
    'Некоторые друзья ещё не начали диалог с ботом.\n\nОтправь им эту ссылку — когда они откроют её, бот покажет намёк:\n{{link}}',
  bot_pro_activated:
    '🎉 PRO подключен!\n\n✅ 10 вишлистов\n✅ 100 желаний в каждом\n✅ Комментарии и импорт по ссылке\n\nДействует до {{date}}',
  bot_open_app: 'Открыть WishBoard ✨',
  bot_multiple_urls: 'Нашёл несколько ссылок. Создаю карточку по первой 👌',
  bot_import_drafts_full:
    'Слишком много неразобранных желаний. Разбери часть в приложении, потом добавляй новые 📦',
  bot_import_error: 'Не удалось обработать ссылку 🤷',
  bot_import_error_retry: 'Не удалось обработать ссылку. Попробуй ещё раз 🤷',
  bot_import_success: '✅ <b>Добавлено в Неразобранное</b>',
  bot_import_parse_failed: '⚠️ Не удалось распознать товар — отредактируй в приложении',
  bot_import_parse_partial: '💡 Распознал не всё — проверь и дополни в приложении',
  bot_import_open: 'Открыть в WishBoard ✨',
  bot_cmd_start: 'Открыть WishBoard',
  bot_cmd_paysupport: 'Помощь с оплатой',
  bot_select_recipients: '👥 Выбрать получателей',

  // ── API strings (user-facing) ─────────────────────────────────────────────
  api_hint_picker_msg: '💡 Намёк на «{{title}}» создан!\n\nВыбери друзей, которым хочешь намекнуть:',
  api_hint_item_not_available: 'На это желание намекать уже не нужно — его забронировали',
  api_hint_item_limit: 'По этому желанию исчерпан лимит намёков.',
  api_hint_daily_limit: 'Лимит намёков на сегодня исчерпан.',
  api_user_fallback: 'Пользователь',
  api_comment_archived: 'Комментарии в архиве запрещены',
  api_comment_empty: 'Комментарий не может быть пустым',
  api_comment_meaningful: 'Напиши что-нибудь содержательное',
  api_comment_cooldown: 'Подожди немного перед следующим комментарием',
  api_comment_duplicate: 'Этот комментарий уже отправлен',
  api_comment_wait_reply: 'Дождись ответа перед отправкой новых комментариев',
  api_comment_hour_limit: 'Слишком много комментариев за час',
  api_comment_month_limit: 'Достигнут лимит комментариев',
  api_system_cant_delete: 'Системные события нельзя удалить',
  api_system_description_updated: 'Описание обновлено',
  api_system_reserved: 'Подарок забронирован',
  api_system_unreserved: 'Бронь отменена',
  api_import_too_many: 'Слишком много неразобранных желаний. Разбери часть, потом добавляй новые.',
  api_import_rate_limit: 'Слишком много запросов. Попробуй через минуту.',
  api_wishlist_items_limit: 'Лимит желаний в этом вишлисте',
  api_invoice_desc: 'Больше вишлистов, комментарии, добавление по ссылке и намёки на подарок',
  api_invoice_label: 'PRO на месяц',

  // ── Notification strings ──────────────────────────────────────────────────
  notif_reserved: '🎁 {{name}} забронировал желание «{{title}}»',
  notif_archived: '📦 Автор поместил желание «{{title}}» в архив',
  notif_completed:
    '✅ Автор отметил желание «{{title}}» как исполненное. Спасибо за подарок! 🎉',
  notif_create_your_wishlist:
    '\n\nА ты уже создал свой вишлист? Открой WishBoard и расскажи друзьям о своих желаниях!',
  notif_description_updated: '📝 Описание обновлено в «{{title}}»',
  notif_commented_reserver: '💬 {{name}} прокомментировал «{{title}}»:\n{{text}}',
  notif_commented_owner: '💬 Автор прокомментировал «{{title}}»:\n{{text}}',
  notif_batch_comments: '💬 У вас {{count}} {{word}} в «{{title}}»',
};

const en: Dict = {
  // ── General / Common ──────────────────────────────────────────────────────
  loading: 'Loading…',
  error_generic: 'Something went wrong',
  error_network: 'Network error',
  cancel: 'Cancel',
  save: 'Save',
  done: 'Done',
  back: 'Back',
  delete: 'Delete',
  close: 'Close',
  retry: 'Retry',
  copy: 'Copy',
  open: 'Open',

  // ── Error screen ──────────────────────────────────────────────────────────
  error_open_in_telegram: 'Open in Telegram',
  error_loading: 'Loading error',
  error_unknown: 'Unknown error',
  error_telegram_only: 'This app only works inside Telegram',
  error_load_failed: 'Failed to load. Please try again.',
  error_open_in_telegram_btn: 'Open in Telegram',

  // ── My Wishlists screen ───────────────────────────────────────────────────
  greeting: 'Hi, {{name}}!',
  my_wishlists: 'My wishlists',
  stats_total: 'Total',
  stats_wishlists: 'wishlists',
  stats_wishes: 'wishes',
  stats_reserved: 'reserved',
  empty_state_title: 'Nothing here yet',
  empty_state_subtitle: 'Create your first wishlist and share with friends!',
  plan_status: '{{plan}}: {{count}} of {{max}} wishlists',
  create_wishlist_btn: '＋ Create wishlist',
  connect_pro: 'Get Pro',
  wishlist_count: '{{count}} wishes • {{reserved}} reserved',
  view_only: 'View only',

  // ── Drafts ────────────────────────────────────────────────────────────────
  drafts_title: 'Inbox',
  drafts_empty: 'Empty',
  drafts_empty_hint: 'Send a product link to the bot or paste a link above',
  drafts_send_link: 'Send a product link to the bot',
  drafts_move: 'Move',
  drafts_archive: 'Archive',
  drafts_open: 'Open ›',
  drafts_url_placeholder: 'Paste a product link…',
  drafts_url_pro_placeholder: 'Product link · Pro',
  drafts_archived_toast: 'Moved to archive. Can be restored within 90 days.',
  drafts_card_created: 'Card created!',
  drafts_move_title: 'Move to wishlist',
  drafts_create_first: 'Create a wishlist first',
  drafts_moved: 'Moved to "{{name}}"',

  // ── Reservations ──────────────────────────────────────────────────────────
  reservations_title: 'My reservations',
  reservations_empty_title: 'Nothing here yet',
  reservations_empty_hint: 'Wishes you reserve from friends will appear here',
  reservations_loading: 'Loading…',
  reservations_open_list: 'Open list',
  reservations_unreserve: 'Cancel reservation',
  reservations_reserved: 'Reserved',

  // ── Wishlist detail ───────────────────────────────────────────────────────
  wishes_count: '{{count}} wishes',
  archive_btn: 'Archive',
  share_btn: 'Share',
  read_only_notice: 'View only — Free plan limit.',
  read_only_upgrade: 'Get Pro',
  read_only_to_edit: ' to edit.',
  surprise_notice: "You can't see who reserved what — it's a surprise!",
  add_first_wish: 'Add your first wish',
  add_first_wish_hint: 'What would you like to receive as a gift?',
  add_wish_btn: '＋ Add wish',

  // ── Item detail (owner) ───────────────────────────────────────────────────
  description_title: 'Description',
  description_edit: 'Edit',
  description_add_prompt: 'Add a description to help friends choose a gift',
  description_add_btn: '+ Add',
  description_placeholder: 'Describe what you want in detail...',
  description_saved: 'Description saved',
  edit_btn: '✏️ Edit',
  received_btn: 'Received ✓',
  delete_btn: 'Delete',
  status_someone_reserved: 'Someone chose this gift ✨',
  status_gifted: '✅ Gifted',

  // ── Item detail (guest) ───────────────────────────────────────────────────
  reserve_btn: '🎁 Reserve',
  reserved_by_me: '✅ Reserved by me',
  cancel_reservation: 'Cancel reservation',
  already_reserved: 'Already reserved',
  after_reserve_hint: 'After reserving, you can leave a comment for the author',

  // ── Reserve bottom sheet ──────────────────────────────────────────────────
  reserve_title: 'Reserve this gift?',
  reserve_name_label: 'Your name (visible to other guests)',
  reserve_name_placeholder: "What's your name?",
  reserve_privacy: "🔒 The wishlist owner <b>won't see</b> who reserved which gift.",
  reserve_success: '🎁 Reserved!',
  unreserve_success: 'Reservation cancelled',

  // ── Comments ──────────────────────────────────────────────────────────────
  comments_title: 'Comments',
  comments_subtitle: 'Private chat between the author and the person who reserved',
  comments_archive_warning: 'Comments will be deleted in 30 days',
  comments_empty: 'Write the first message',
  comments_placeholder: 'Write a comment...',
  comments_anon: 'Anonymous',
  comments_me: 'Me',
  comments_pro_title: 'Comments',
  comments_pro_hint: 'Discuss gift details with the person who reserved',
  comments_pro_more: 'Learn more →',
  comments_max_chars: 'Maximum 300 characters',
  comments_write_something: 'Write something meaningful',
  comments_send_error: 'Send error',
  comments_delete_error: 'Delete error',

  // ── Hints ─────────────────────────────────────────────────────────────────
  hint_friends_btn: 'Hint to friends',
  hint_subtitle: 'Gently hint about your wishes',
  hint_reserved_notice: "No need to hint about this — it's been reserved",
  hint_closing: 'Sending to bot...',
  hint_limit_exhausted: 'Limit reached.',

  // ── Hint formatRetryAfter ─────────────────────────────────────────────────
  retry_now: 'Try again.',
  retry_minutes: 'Try again in {{minutes}} min.',
  retry_hours: 'Try again in {{hours}}h {{minutes}}min.',
  retry_hours_only: 'Try again in {{hours}}h.',
  retry_tomorrow: 'Try again tomorrow at {{time}}.',

  // ── Create wishlist form ──────────────────────────────────────────────────
  new_wishlist: 'New wishlist',
  wishlist_name: 'Name',
  wishlist_name_placeholder: 'e.g. Birthday 2026 🎂',
  wishlist_deadline: 'Deadline (optional)',
  wishlist_create_btn: '✨ Create',
  wishlist_created: '✅ Wishlist created!',

  // ── Rename wishlist ───────────────────────────────────────────────────────
  rename_title: 'Rename wishlist',
  rename_placeholder: 'Wishlist name',
  rename_success: 'Name updated',

  // ── Item form ─────────────────────────────────────────────────────────────
  item_form_edit: 'Edit',
  item_form_new: 'New wish',
  item_name: 'Name',
  item_name_placeholder: 'e.g. AirPods Pro 3',
  item_description: 'Description (optional)',
  item_description_placeholder: 'Details about the wish...',
  item_url: 'Link (optional)',
  item_photo: 'Photo',
  item_photo_select: 'Choose photo',
  item_photo_replace: 'Replace photo',
  item_photo_delete: 'Delete photo',
  item_photo_uploading: 'Uploading...',
  item_photo_error: 'Photo upload error',
  item_photo_network_error: 'Network error uploading photo',
  item_photo_only_images: 'Images only (JPEG, PNG, WebP, GIF)',
  item_photo_too_large: 'File too large. Maximum 30 MB',
  item_price: 'Price (optional)',
  item_priority: 'Priority',
  item_saved: '✅ Saved!',
  item_added: '✅ Wish added!',
  item_add_btn: '✨ Add',

  // ── Priority labels ───────────────────────────────────────────────────────
  priority_low: 'Nice to have',
  priority_low_sub: 'Low priority',
  priority_medium: 'Want',
  priority_medium_sub: 'Medium priority',
  priority_high: 'Dream',
  priority_high_sub: 'High priority',

  // ── Delete confirmation ───────────────────────────────────────────────────
  delete_title: 'Delete wish?',
  delete_deleted: '🗑 Deleted',

  // ── Archive ───────────────────────────────────────────────────────────────
  archive_title: 'Archive',
  archive_retention: 'Archived wishes are stored for 90 days',
  archive_empty: 'Archive is empty',
  archive_empty_hint: 'Deleted and received wishes will appear here',
  archive_received: 'Received',
  archive_deleted: 'Deleted',
  archive_restore: '↩ Restore',
  archive_restored: 'Restored!',
  archive_received_toast: 'Received!',

  // ── Settings ──────────────────────────────────────────────────────────────
  settings_title: 'Settings',
  settings_plan: 'Plan',
  settings_wishlists: 'Wishlists',
  settings_wishes_each: 'Wishes per list',
  settings_participants: 'Participants',
  settings_comments: 'Comments',
  settings_url_import: 'Import by link',
  settings_hints: 'Gift hints',
  settings_next_renewal: 'Next renewal',
  settings_renewal_disabled: 'Renewal cancelled. Pro until',
  settings_cancel_renewal: 'Cancel renewal',
  settings_resume_sub: 'Resume subscription',
  settings_resuming: 'Updating…',
  settings_god_mode: '⚡ God Mode',
  settings_god_active: 'PRO without subscription, no limits',
  settings_god_inactive: 'Virtual PRO for testing',
  settings_up_to: 'up to {{n}}',

  // ── Settings - PRO benefit descriptions ───────────────────────────────────
  settings_desc_wishlists: 'Organize by events and people',
  settings_desc_wishes: 'More room for your wishes',
  settings_desc_participants: 'Bring friends into one wishlist',
  settings_desc_comments: 'Discuss gifts right in the card',
  settings_desc_url_import: 'Bot fills in the card from a link',
  settings_desc_hints: 'Suggest a specific idea to friends',

  // ── Cancel subscription ───────────────────────────────────────────────────
  cancel_title: 'Cancel renewal?',
  cancel_notice: 'Pro stays until',
  cancel_after: 'After that, the plan changes to Free.',
  cancel_btn: 'Cancel renewal',
  cancel_cancelling: 'Cancelling…',
  cancel_keep: 'Keep Pro',
  cancel_success: 'Renewal cancelled',

  // ── Pro Upsell ────────────────────────────────────────────────────────────
  upsell_checkout_loading: 'Processing…',
  upsell_cta: 'Get Pro',
  upsell_not_now: 'Not now',
  upsell_auto_renew: 'Auto-renewal · cancel anytime',
  upsell_per_month: '/ mo',
  upsell_comments_title: 'Gift Comments',
  upsell_comments_subtitle: 'Discuss details with the person who reserved — right in the card.',
  upsell_comments_b1: 'Private chat with the reserver',
  upsell_comments_b2: 'Clarify size, color and details',
  upsell_comments_b3: 'All history in one place',
  upsell_url_title: 'Import by Link',
  upsell_url_subtitle:
    'Just send a link to the bot — it will pull the title, photo and price. Just move it to the right wishlist.',
  upsell_url_b1: 'Auto-fill card from a link',
  upsell_url_b2: 'Popular store support',
  upsell_url_b3: 'Add a wish in two clicks',
  upsell_hints_title: 'Gift Hints',
  upsell_hints_subtitle: 'Gently hint to friends what you want — no awkwardness.',
  upsell_hints_b1: 'Gentle hint for friends',
  upsell_hints_b2: 'Link to a specific wish',
  upsell_hints_b3: 'No awkward gift conversations',
  upsell_wl_title: 'Need more wishlists?',
  upsell_wl_subtitle: 'Free plan: 2 wishlists. Pro: up to 10.',
  upsell_item_title: 'Wish limit reached',
  upsell_item_subtitle: 'Free: up to 30 per list. Pro: up to 100.',
  upsell_part_title: 'Too many participants',
  upsell_part_subtitle: 'Free: up to 5 participants. Pro: up to 20.',

  // ── Comparison table labels ───────────────────────────────────────────────
  table_wishlists: 'Wishlists',
  table_wishes: 'Wishes',
  table_participants: 'Participants',
  table_comments: 'Comments',
  table_by_link: 'By link',
  table_hints: 'Hints',

  // ── Share screen ──────────────────────────────────────────────────────────
  share_title: 'Share',
  share_link_error: 'Failed to create link. Try again later.',
  share_copied: '📨 Link copied',
  share_tg_btn: '✈️ Share via Telegram',
  share_copy_btn: '📋 Copy link',
  share_privacy:
    "🔒 Friends will see the list but won't know who reserved what. You won't see the details either — surprise!",
  share_text: '🎁 {{title}}\nChoose a gift here 👇',

  // ── Price filters ─────────────────────────────────────────────────────────
  filter_all: 'All',
  filter_under_3k: 'Under 3,000 ₽',
  filter_under_10k: 'Under 10,000 ₽',
  filter_under_25k: 'Under 25,000 ₽',

  // ── Toasts / errors ───────────────────────────────────────────────────────
  toast_plan_limit: 'Plan limit reached',
  toast_url_error: 'Failed to process link',
  toast_url_import_error: 'Error processing link',
  toast_move_error: 'Failed to move',
  toast_move_error_generic: 'Error moving',
  toast_error_generic: 'Error',
  toast_create_error: 'Creation error',
  toast_save_error: 'Save error',
  toast_add_error: 'Add error',
  toast_delete_error: 'Delete error',
  toast_restore_error: 'Restore error',
  toast_load_error: 'Load error',
  toast_archive_error: 'Archive load error',
  toast_already_reserved: 'Already reserved',
  toast_max_participants: 'Maximum participants in this wishlist',
  toast_already_pro: 'You already have Pro ✨',
  toast_checkout_error: 'Failed to start checkout',
  toast_update_telegram: 'Update Telegram to pay',
  toast_pro_activated: 'Pro activated! ✨',
  toast_payment_syncing: 'Payment successful! Data will update in a few seconds',
  toast_payment_failed: 'Payment failed',
  toast_cancel_error: 'Failed to cancel',
  toast_renewal_resumed: 'Renewal resumed ✨',
  toast_renewing_new: 'Setting up new subscription…',
  toast_god_toggle_error: 'Failed to toggle',
  toast_max_wishlists: 'Maximum {{n}} wishlists on Pro',
  toast_max_items: 'Maximum {{n}} wishes on Pro',
  toast_profile_coming: 'Profile coming in future versions',
  link_label: '🔗 link',

  // ── Plural helpers (English uses singular/plural only) ────────────────────
  cards_one: 'card',
  cards_few: 'cards',
  cards_many: 'cards',
  wishes_one: 'wish',
  wishes_few: 'wishes',
  wishes_many: 'wishes',

  // ── Bot strings ───────────────────────────────────────────────────────────
  bot_menu_btn: 'Wishlist',
  bot_start:
    'Hi! WishBoard is your personal wishlist 🎁\nTap the "Wishlist" button below to open the app.',
  bot_help:
    "WishBoard — create wishlists and share them with friends.\n\n/start — get started\n/paysupport — payment help\n\nSend a product link — I'll create a wish card!",
  bot_paysupport:
    "💳 Payment help\n\nIf you're having issues with payment or PRO subscription:\n\n1. Make sure you have enough Telegram Stars\n2. Try restarting the app and retrying payment\n3. If the problem persists — describe the issue in this chat, we'll sort it out 🙏",
  bot_view_wishlist: 'Check out this wishlist 🎁',
  bot_view_wishlist_btn: 'View wishlist 🎁',
  bot_hint_unavailable: 'This wish is no longer available 🤷',
  bot_hint_self: 'No need to hint to yourself 😊',
  bot_hint_reserved: "No need to hint about this — it's already reserved 🎁",
  bot_hint_msg:
    'Gift idea for {{owner}} 🎁\n\nCheck out the wish "{{title}}" — it seems {{shortName}} really wants this.',
  bot_hint_view_btn: 'View wish 🎁',
  bot_error: 'An error occurred. Try again later 🙈',
  bot_users_shared_no_profile: 'Could not find your profile. Open the app and try again.',
  bot_users_shared_no_hint: 'No active hint found. Create a new one in the app.',
  bot_users_shared_reserved: 'This wish is already reserved — no hint needed 🎁',
  bot_sent_count: '✅ Sent directly: {{n}}',
  bot_pending_count: "⏳ Failed to send: {{n}} (no chat with bot)",
  bot_no_recipients: 'No recipients selected.',
  bot_fallback_msg:
    "Some friends haven't started a chat with the bot yet.\n\nSend them this link — when they open it, the bot will show the hint:\n{{link}}",
  bot_pro_activated:
    '🎉 PRO activated!\n\n✅ 10 wishlists\n✅ 100 wishes each\n✅ Comments and import by link\n\nActive until {{date}}',
  bot_open_app: 'Open WishBoard ✨',
  bot_multiple_urls: 'Found multiple links. Creating a card from the first one 👌',
  bot_import_drafts_full: 'Too many unprocessed wishes. Sort some in the app first 📦',
  bot_import_error: 'Failed to process link 🤷',
  bot_import_error_retry: 'Failed to process link. Try again 🤷',
  bot_import_success: '✅ <b>Added to Inbox</b>',
  bot_import_parse_failed: '⚠️ Could not parse the product — edit in the app',
  bot_import_parse_partial: '💡 Partially parsed — check and complete in the app',
  bot_import_open: 'Open in WishBoard ✨',
  bot_cmd_start: 'Open WishBoard',
  bot_cmd_paysupport: 'Payment help',
  bot_select_recipients: '👥 Select recipients',

  // ── API strings (user-facing) ─────────────────────────────────────────────
  api_hint_picker_msg: '💡 Hint for "{{title}}" created!\n\nSelect friends you want to hint to:',
  api_hint_item_not_available: "No need to hint about this — it's been reserved",
  api_hint_item_limit: 'Hint limit for this wish reached.',
  api_hint_daily_limit: 'Daily hint limit reached.',
  api_user_fallback: 'User',
  api_comment_archived: 'Comments in archive are not allowed',
  api_comment_empty: 'Comment cannot be empty',
  api_comment_meaningful: 'Write something meaningful',
  api_comment_cooldown: 'Wait a moment before the next comment',
  api_comment_duplicate: 'This comment has already been sent',
  api_comment_wait_reply: 'Wait for a reply before sending new comments',
  api_comment_hour_limit: 'Too many comments per hour',
  api_comment_month_limit: 'Comment limit reached',
  api_system_cant_delete: 'System events cannot be deleted',
  api_system_description_updated: 'Description updated',
  api_system_reserved: 'Gift reserved',
  api_system_unreserved: 'Reservation cancelled',
  api_import_too_many: 'Too many unprocessed wishes. Sort some first, then add new ones.',
  api_import_rate_limit: 'Too many requests. Try again in a minute.',
  api_wishlist_items_limit: 'Wish limit for this wishlist',
  api_invoice_desc: 'More wishlists, comments, import by link and gift hints',
  api_invoice_label: 'PRO for a month',

  // ── Notification strings ──────────────────────────────────────────────────
  notif_reserved: '🎁 {{name}} reserved the wish "{{title}}"',
  notif_archived: '📦 The author archived the wish "{{title}}"',
  notif_completed: '✅ The author marked "{{title}}" as received. Thank you for the gift! 🎉',
  notif_create_your_wishlist:
    '\n\nHave you created your wishlist yet? Open WishBoard and tell your friends about your wishes!',
  notif_description_updated: '📝 Description updated in "{{title}}"',
  notif_commented_reserver: '💬 {{name}} commented on "{{title}}":\n{{text}}',
  notif_commented_owner: '💬 Author commented on "{{title}}":\n{{text}}',
  notif_batch_comments: '💬 You have {{count}} new {{word}} in "{{title}}"',
};

// ─── Dictionaries map ─────────────────────────────────────────────────────────

const dicts: Record<Locale, Dict> = { ru, en };

// ─── Interpolation ────────────────────────────────────────────────────────────

/**
 * Replace `{{param}}` placeholders in a string with values from `params`.
 */
function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const val = params[key];
    return val !== undefined ? String(val) : `{{${key}}}`;
  });
}

// ─── Translation function ─────────────────────────────────────────────────────

/**
 * Look up `key` in the given `locale` dictionary.
 * Falls back to Russian if the key is missing from the English dictionary.
 * Supports `{{param}}` interpolation via the optional `params` argument.
 */
export function t(
  key: string,
  locale: Locale,
  params?: Record<string, string | number>,
): string {
  const dict = dicts[locale];
  const template = dict[key] ?? dicts['ru'][key] ?? key;
  return interpolate(template, params);
}

// ─── Pluralisation helper ─────────────────────────────────────────────────────

/**
 * Return the correct plural form for `n`.
 *
 * For Russian the three-form rule applies:
 *   one  → 1, 21, 31 … (ends in 1, but not 11)
 *   few  → 2-4, 22-24 … (ends in 2-4, but not 12-14)
 *   many → everything else
 *
 * For English only two forms are used:
 *   one  → n === 1
 *   many → everything else  (uses the `few`/`many` form — both are identical)
 */
export function pluralize(
  n: number,
  one: string,
  few: string,
  many: string,
  locale: Locale,
): string {
  if (locale === 'ru') {
    const abs = Math.abs(n);
    const mod10 = abs % 10;
    const mod100 = abs % 100;
    if (mod10 === 1 && mod100 !== 11) return one;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
    return many;
  }
  // English: singular vs plural
  return n === 1 ? one : few;
}
