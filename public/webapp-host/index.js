(() => {
  const params = new URLSearchParams(window.location.search);
  const appUrl = params.get('url') || '';
  const titleParam = params.get('title') || '';

  const headerEl = document.getElementById('header');
  const titleEl = document.getElementById('title');
  const frameEl = document.getElementById('frame');
  const backBtn = document.getElementById('backBtn');
  const closeBtn = document.getElementById('closeBtn');
  const bottomBar = document.getElementById('bottomBar');
  const mainButton = document.getElementById('mainButton');
  const fallbackEl = document.getElementById('fallback');
  const fallbackText = document.getElementById('fallbackText');
  const fallbackAction = document.getElementById('fallbackAction');

  let appOrigin = '';
  let isReady = false;
  let readyTimer = 0;

  const TELEGRAM_INTERNAL_HOSTS = new Set(['webappinternal.telegram.org']);

  function isTelegramInternal(url) {
    try {
      return TELEGRAM_INTERNAL_HOSTS.has(new URL(url).hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  function setHeaderColor(color) {
    if (!color) return;
    headerEl.style.backgroundColor = color;
  }

  function setTitle(text) {
    const value = (text || 'Mini App').trim();
    titleEl.textContent = value;
    document.title = value;
  }

  function sendToApp(event) {
    if (!frameEl.contentWindow) return;
    frameEl.contentWindow.postMessage(JSON.stringify(event), appOrigin || '*');
  }

  function relayToOpener(event) {
    if (!window.opener || window.opener.closed) return;
    try {
      window.opener.postMessage(JSON.stringify(event), window.location.origin);
    } catch {
      // Ignore
    }
  }

  function closeHost() {
    relayToOpener({ eventType: 'web_app_close' });
    window.close();
  }

  function showFallback(message, actionLabel, onAction) {
    frameEl.classList.add('isHidden');
    fallbackEl.hidden = false;
    fallbackText.textContent = message;
    fallbackAction.textContent = actionLabel;
    fallbackAction.onclick = onAction;
  }

  function sendViewport() {
    sendToApp({
      eventType: 'viewport_changed',
      eventData: {
        width: frameEl.clientWidth,
        height: frameEl.clientHeight,
        is_state_stable: true,
        is_expanded: true,
      },
    });
  }

  function sendTheme() {
    const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    sendToApp({
      eventType: 'theme_changed',
      eventData: {
        theme_params: {
          bg_color: isDark ? '#0f0f0f' : '#ffffff',
          secondary_bg_color: isDark ? '#212121' : '#f4f4f5',
          text_color: isDark ? '#ffffff' : '#000000',
          hint_color: isDark ? '#aaaaaa' : '#999999',
          link_color: '#3390ec',
          button_color: '#3390ec',
          button_text_color: '#ffffff',
          header_bg_color: isDark ? '#212121' : '#ffffff',
          accent_text_color: '#3390ec',
          section_bg_color: isDark ? '#212121' : '#ffffff',
          section_header_text_color: '#3390ec',
          subtitle_text_color: isDark ? '#aaaaaa' : '#707579',
          destructive_text_color: '#e53935',
        },
      },
    });
  }

  function sendSafeArea() {
    sendToApp({
      eventType: 'safe_area_changed',
      eventData: {
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
      },
    });
    sendToApp({
      eventType: 'content_safe_area_changed',
      eventData: {
        top: 0,
        bottom: 0,
        left: 0,
        right: 0,
      },
    });
  }

  function handleInbound(event) {
    if (event.source !== frameEl.contentWindow) return;

    let data;
    try {
      data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    } catch {
      return;
    }
    if (!data || !data.eventType) return;

    const { eventType, eventData } = data;

    if (eventType === 'web_app_ready' || eventType === 'iframe_ready') {
      isReady = true;
      window.clearTimeout(readyTimer);
      return;
    }

    if (eventType === 'web_app_close') {
      closeHost();
      return;
    }

    if (eventType === 'web_app_setup_back_button') {
      backBtn.hidden = !eventData?.is_visible;
      return;
    }

    if (eventType === 'web_app_setup_main_button') {
      const isVisible = Boolean(eventData?.is_visible && eventData?.text);
      bottomBar.hidden = !isVisible;
      if (!isVisible) return;

      mainButton.textContent = eventData.text;
      mainButton.disabled = eventData.is_active === false;
      if (eventData.color) mainButton.style.backgroundColor = eventData.color;
      if (eventData.text_color) mainButton.style.color = eventData.text_color;
      return;
    }

    if (eventType === 'web_app_set_header_color') {
      setHeaderColor(eventData?.color);
      return;
    }

    if (eventType === 'web_app_request_theme') {
      sendTheme();
      return;
    }

    if (eventType === 'web_app_request_viewport') {
      sendViewport();
      return;
    }

    if (eventType === 'web_app_request_safe_area' || eventType === 'web_app_request_content_safe_area') {
      sendSafeArea();
      return;
    }

    if (eventType === 'web_app_open_link' || eventType === 'web_app_open_tg_link') {
      relayToOpener(data);
    }
  }

  function init() {
    setTitle(titleParam || 'Mini App');

    backBtn.addEventListener('click', () => {
      sendToApp({ eventType: 'back_button_pressed' });
    });
    closeBtn.addEventListener('click', closeHost);
    mainButton.addEventListener('click', () => {
      sendToApp({ eventType: 'main_button_pressed' });
    });

    window.addEventListener('message', handleInbound);
    window.addEventListener('resize', sendViewport);

    if (!appUrl) {
      showFallback(
        'No Mini App URL was provided.',
        'Close',
        closeHost,
      );
      return;
    }

    if (isTelegramInternal(appUrl)) {
      showFallback(
        'This Mini App cannot run inside a hosted window. Continue in BotFather chat instead.',
        'Open BotFather',
        () => {
          relayToOpener({
            eventType: 'web_app_open_tg_link',
            eventData: { path_full: 'botfather' },
          });
          closeHost();
        },
      );
      return;
    }

    try {
      appOrigin = new URL(appUrl).origin;
    } catch {
      showFallback('Invalid Mini App URL.', 'Close', closeHost);
      return;
    }

    frameEl.src = appUrl;
    readyTimer = window.setTimeout(() => {
      if (isReady) return;
      showFallback(
        'This Mini App did not load in the hosted window. It may block embedding.',
        'Open directly',
        () => {
          window.location.href = appUrl;
        },
      );
    }, 8000);
  }

  init();
})();
