// ru/en copy for the Wave 1 pmf-discovery survey.
//
// optionId keys here MUST match apps/api/src/services/research-survey/
// survey-pmf-v1.ts. If a key is missing from the dict, the UI falls back
// to the raw optionId — that's an audit signal, not a crash.
//
// Translation freedom: text is editable freely after release; only the
// optionId keys are frozen.

export type SurveyLocale = 'ru' | 'en';

export interface SurveyCopy {
  intro: { title: string; subtitle: string };
  progress: string; // {{n}} {{total}}
  multiHint: string; // {{max}}
  npsHint: string;
  btn: {
    next: string;
    back: string;
    skip: string;
    submit: string;
    dismiss: string;
  };
  dismiss: {
    title: string;
    body: string;
    confirm: string;
    cancel: string;
  };
  q: Record<
    string,
    { title: string; hint?: string; placeholder?: string; charCounter?: string; options?: Record<string, string> }
  >;
  completion: {
    pro30d: { title: string; subtitle: string; btn: string };
    lifetime: { title: string; subtitle: string; btn: string };
  };
  loading: string;
  loadError: string;
  saveError: string;
  alreadyCompleted: string;
  surveyClosed: string;
}

const ru: SurveyCopy = {
  intro: {
    title: 'Короткий опрос WishBoard',
    subtitle: '10 вопросов, меньше 2 минут. За ответы — месяц PRO.',
  },
  progress: 'Вопрос {{n}} из {{total}}',
  multiHint: 'Выбери до {{max}} вариантов',
  npsHint: '0 — точно нет, 10 — точно да',
  btn: {
    next: 'Дальше',
    back: 'Назад',
    skip: 'Пропустить',
    submit: 'Завершить',
    dismiss: 'Не сейчас',
  },
  dismiss: {
    title: 'Закрыть опрос?',
    body: 'Прогресс не сохраняется, и месяц PRO мы дадим только после завершения.',
    confirm: 'Закрыть',
    cancel: 'Продолжить',
  },
  q: {
    q1: {
      title: 'Зачем ты пробовал WishBoard?',
      options: {
        curiosity: 'Просто посмотреть',
        gift_planning: 'Искал что подарить кому-то',
        birthday_self: 'Мой день рождения близко',
        holiday: 'Новый год или другой праздник',
        wedding: 'Свадьба или крупное событие',
        baby_registry: 'Рождение ребёнка',
        friend_invite: 'Друг прислал ссылку',
        replace_other_tool: 'Хотел заменить заметки/Excel',
        other: 'Другое',
      },
    },
    q2: {
      title: 'Для какого случая он был тебе нужен?',
      options: {
        own_birthday: 'Мой день рождения',
        partner_birthday: 'ДР партнёра',
        kid_birthday: 'ДР ребёнка',
        friend_birthday: 'ДР друга',
        new_year_christmas: 'Новый год / Рождество',
        wedding: 'Свадьба',
        baby_shower: 'Рождение ребёнка',
        housewarming: 'Новоселье',
        self_treat: 'Хотелки на будущее',
        no_specific_occasion: 'Без конкретного повода',
        other: 'Другое',
      },
    },
    q3: {
      title: 'Что показалось самым полезным?',
      options: {
        adding_items: 'Легко добавлять желания',
        url_import: 'Вставка ссылки с автозаполнением',
        share_link: 'Ссылка-делиться',
        reservations_anonymous: 'Анонимные брони — без спойлеров',
        multiple_wishlists: 'Несколько вишлистов',
        birthday_calendar: 'Календарь ДР',
        categories: 'Категории',
        hints: 'Подсказки/советы',
        pro_features: 'Платные фичи',
        mini_app_in_telegram: 'Нативность в Telegram',
        nothing_special: 'Ничего особенного',
        other: 'Другое',
      },
    },
    q4: {
      title: 'Что больше всего мешало?',
      options: {
        ui_confusing: 'Запутался в интерфейсе',
        url_import_broken: 'Вставка ссылок плохо работает',
        friends_not_in_telegram: 'Друзья не в Telegram',
        nobody_to_share_with: 'Некому делиться',
        forgot_to_use: 'Забыл вернуться',
        not_enough_features: 'Не хватает функций',
        bugs_or_crashes: 'Баги',
        not_relevant_now: 'Сейчас не актуально',
        nothing_blocked: 'Ничего не мешало',
        other: 'Другое',
      },
    },
    q5: {
      title: 'Делился ли своим вишлистом?',
      options: {
        yes_friends_family: 'Да, с друзьями/семьёй',
        yes_partner_only: 'Только с партнёром',
        yes_link_no_response: 'Отправил, но никто не отреагировал',
        no_didnt_want: 'Не хотел',
        no_didnt_know_how: 'Не разобрался как',
        no_nothing_to_share: 'Нечего было показать',
        no_too_early: 'Ещё рано',
      },
    },
    q6: {
      title: 'Что помогло бы пользоваться чаще?',
      options: {
        reminders_birthdays: 'Напоминания о ДР друзей',
        reminders_my_own: 'Напоминания вернуться',
        url_import_better: 'Лучше вставка ссылок',
        shopping_assistant: 'Помощь с покупками',
        group_gifting: 'Сбор группой на подарок',
        price_drop_alerts: 'Алерты о скидках',
        friends_already_inside: 'Если бы друзья уже были тут',
        web_version: 'Веб-версия',
        nothing_would_help: 'Ничего не поможет',
        other: 'Другое',
      },
    },
    q7: {
      title: 'За что было бы честно брать деньги?',
      options: {
        unlimited_wishlists: 'Без лимита на вишлисты',
        unlimited_items: 'Без лимита на желания',
        ai_suggestions: 'AI-подсказки',
        group_gifting: 'Сбор группой',
        private_wishlists: 'Приватные списки',
        secret_santa: 'Тайный Санта',
        price_tracking: 'Отслеживание цен',
        premium_calendar: 'Расширенный календарь',
        gift_history: 'История подарков',
        nothing_worth_paying: 'Ничего не стоит денег',
        other: 'Другое',
      },
    },
    q8: {
      title: 'Если бы WishBoard завтра исчез, насколько тебе было бы жалко?',
      options: {
        very_disappointed: 'Очень расстроюсь',
        somewhat_disappointed: 'Немного расстроюсь',
        not_disappointed: 'Не расстроюсь',
        not_using_anyway: 'Уже не пользуюсь',
      },
    },
    q9: {
      title: 'Насколько вероятно, что посоветуешь WishBoard другу?',
      hint: '0 — точно нет, 10 — точно да',
    },
    q10: {
      title: 'Что бы ты изменил или добавил в первую очередь?',
      placeholder: 'Опционально, до 500 символов',
      charCounter: '{{count}} / 500',
    },
  },
  completion: {
    pro30d: {
      title: 'Спасибо! Месяц PRO активирован',
      subtitle: 'Если хочешь добавить что-то ещё — напиши боту, мы читаем всё.',
      btn: 'Открыть WishBoard',
    },
    lifetime: {
      title: 'Спасибо! У тебя уже lifetime PRO',
      subtitle: 'Дать ещё PRO мы не можем — у тебя он уже навсегда. Но твои ответы суперважные.',
      btn: 'Открыть WishBoard',
    },
  },
  loading: 'Загружаем опрос…',
  loadError: 'Не удалось загрузить опрос. Попробуй открыть ссылку ещё раз.',
  saveError: 'Не удалось сохранить ответ. Попробуй ещё раз.',
  alreadyCompleted: 'Опрос уже пройден. Спасибо!',
  surveyClosed: 'Этот опрос завершён. Спасибо за интерес!',
};

const en: SurveyCopy = {
  intro: {
    title: 'Short WishBoard study',
    subtitle: '10 questions, under 2 minutes. A month of PRO as thanks.',
  },
  progress: 'Question {{n}} of {{total}}',
  multiHint: 'Choose up to {{max}}',
  npsHint: '0 = definitely no, 10 = definitely yes',
  btn: {
    next: 'Next',
    back: 'Back',
    skip: 'Skip',
    submit: 'Finish',
    dismiss: 'Not now',
  },
  dismiss: {
    title: 'Close the survey?',
    body: 'Progress is not saved, and the month of PRO is only granted after you finish.',
    confirm: 'Close',
    cancel: 'Keep going',
  },
  q: {
    q1: {
      title: 'Why did you try WishBoard?',
      options: {
        curiosity: 'Just curious',
        gift_planning: 'Looking for a gift idea',
        birthday_self: 'My birthday is coming up',
        holiday: 'New Year or another holiday',
        wedding: 'Wedding or a major event',
        baby_registry: 'New baby',
        friend_invite: 'A friend sent me a link',
        replace_other_tool: 'Wanted to replace notes/Excel',
        other: 'Other',
      },
    },
    q2: {
      title: 'What occasion did you need it for?',
      options: {
        own_birthday: 'My birthday',
        partner_birthday: 'Partner\'s birthday',
        kid_birthday: 'My kid\'s birthday',
        friend_birthday: 'A friend\'s birthday',
        new_year_christmas: 'New Year / Christmas',
        wedding: 'Wedding',
        baby_shower: 'Baby arrival',
        housewarming: 'Housewarming',
        self_treat: 'Wishes for myself',
        no_specific_occasion: 'No specific occasion',
        other: 'Other',
      },
    },
    q3: {
      title: 'What felt most useful?',
      options: {
        adding_items: 'Easy to add wishes',
        url_import: 'URL paste auto-fill',
        share_link: 'Share link',
        reservations_anonymous: 'Anonymous reservations — no spoilers',
        multiple_wishlists: 'Multiple wishlists',
        birthday_calendar: 'Birthday calendar',
        categories: 'Categories',
        hints: 'Hints / suggestions',
        pro_features: 'PRO features',
        mini_app_in_telegram: 'Native Telegram feel',
        nothing_special: 'Nothing in particular',
        other: 'Other',
      },
    },
    q4: {
      title: 'What got in the way most?',
      options: {
        ui_confusing: 'UI was confusing',
        url_import_broken: 'URL paste didn\'t work well',
        friends_not_in_telegram: 'My friends aren\'t on Telegram',
        nobody_to_share_with: 'Nobody to share with',
        forgot_to_use: 'I forgot to come back',
        not_enough_features: 'Not enough features',
        bugs_or_crashes: 'Bugs / crashes',
        not_relevant_now: 'Not relevant right now',
        nothing_blocked: 'Nothing blocked me',
        other: 'Other',
      },
    },
    q5: {
      title: 'Did you share your wishlist?',
      options: {
        yes_friends_family: 'Yes — with friends or family',
        yes_partner_only: 'Yes — partner only',
        yes_link_no_response: 'Sent it, but no one reacted',
        no_didnt_want: 'No — didn\'t want to',
        no_didnt_know_how: 'No — didn\'t figure out how',
        no_nothing_to_share: 'No — nothing worth showing',
        no_too_early: 'Too early; list wasn\'t ready',
      },
    },
    q6: {
      title: 'What would help you use WishBoard more?',
      options: {
        reminders_birthdays: 'Birthday reminders for friends',
        reminders_my_own: 'Reminders to come back',
        url_import_better: 'Better URL paste',
        shopping_assistant: 'Shopping assistant',
        group_gifting: 'Pool money with friends',
        price_drop_alerts: 'Price-drop alerts',
        friends_already_inside: 'If friends were already here',
        web_version: 'Web version',
        nothing_would_help: 'Nothing would help',
        other: 'Other',
      },
    },
    q7: {
      title: 'What\'s fair to charge money for?',
      options: {
        unlimited_wishlists: 'Unlimited wishlists',
        unlimited_items: 'Unlimited items',
        ai_suggestions: 'AI suggestions',
        group_gifting: 'Group gifting',
        private_wishlists: 'Private lists',
        secret_santa: 'Secret Santa',
        price_tracking: 'Price tracking',
        premium_calendar: 'Enhanced calendar',
        gift_history: 'Gift history',
        nothing_worth_paying: 'Nothing worth paying for',
        other: 'Other',
      },
    },
    q8: {
      title: 'If WishBoard disappeared tomorrow, how would you feel?',
      options: {
        very_disappointed: 'Very disappointed',
        somewhat_disappointed: 'A bit disappointed',
        not_disappointed: 'Not disappointed',
        not_using_anyway: 'I\'m not using it anyway',
      },
    },
    q9: {
      title: 'How likely are you to recommend WishBoard to a friend?',
      hint: '0 = definitely no, 10 = definitely yes',
    },
    q10: {
      title: 'What would you change or add first?',
      placeholder: 'Optional, up to 500 characters',
      charCounter: '{{count}} / 500',
    },
  },
  completion: {
    pro30d: {
      title: 'Thanks! A month of PRO is on you',
      subtitle: 'If you want to add anything else, DM the bot — we read everything.',
      btn: 'Open WishBoard',
    },
    lifetime: {
      title: 'Thanks! You already have lifetime PRO',
      subtitle: 'We can\'t give you more PRO (you already have it forever), but your answers matter a lot.',
      btn: 'Open WishBoard',
    },
  },
  loading: 'Loading the survey…',
  loadError: 'Couldn\'t load the survey. Try opening the link again.',
  saveError: 'Couldn\'t save the answer. Try again.',
  alreadyCompleted: 'You\'ve already finished this survey. Thanks!',
  surveyClosed: 'This survey is closed. Thanks for the interest!',
};

const COPY: Record<SurveyLocale, SurveyCopy> = { ru, en };

export function getCopy(locale: SurveyLocale | string): SurveyCopy {
  return locale === 'ru' ? COPY.ru : COPY.en;
}

export function formatTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? ''));
}
