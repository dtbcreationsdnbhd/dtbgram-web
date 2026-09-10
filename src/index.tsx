import TeactDOM from './lib/teact/teact-dom';

import { requestMutation } from './lib/fasterdom/fasterdom';

import AppLockGate from './components/main/AppLockGate';

const APP_LOCK_SESSION_KEY = 'app_lock_passed';
const DISGUISE_TITLE = 'home';
const FAVICON_SIZE = 64;

bootstrap();

function bootstrap() {
  if (!(window as any).isCompatTestPassed) return;

  if (sessionStorage.getItem(APP_LOCK_SESSION_KEY) === '1') {
    void startMainApp();
    return;
  }

  disguiseTab();

  requestMutation(() => {
    TeactDOM.render(
      <AppLockGate onUnlock={handleAppUnlock} />,
      document.getElementById('root')!,
    );
  });
}

function handleAppUnlock() {
  sessionStorage.setItem(APP_LOCK_SESSION_KEY, '1');
  void startMainApp();
}

// Loaded lazily so no app code, styles, fonts or icons hit the network while the lock page is shown
async function startMainApp() {
  const { default: startApp } = await import('./appBootstrap');
  await startApp();
}

// Hides the real app identity behind a neutral title and a randomly generated favicon
function disguiseTab() {
  document.title = DISGUISE_TITLE;
  document.body.style.margin = '0';

  document.querySelectorAll('link[rel*="icon"], link[rel="manifest"]').forEach((el) => el.remove());

  const link = document.createElement('link');
  link.setAttribute('rel', 'icon');
  link.setAttribute('data-app-lock-favicon', '');
  link.setAttribute('href', generateRandomFavicon());
  document.head.appendChild(link);
}

function generateRandomFavicon() {
  const canvas = document.createElement('canvas');
  canvas.width = FAVICON_SIZE;
  canvas.height = FAVICON_SIZE;

  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = getRandomColor();
  ctx.fillRect(0, 0, FAVICON_SIZE, FAVICON_SIZE);

  ctx.fillStyle = getRandomColor();
  ctx.beginPath();
  ctx.arc(FAVICON_SIZE / 2, FAVICON_SIZE / 2, FAVICON_SIZE / 3, 0, Math.PI * 2);
  ctx.fill();

  return canvas.toDataURL('image/png');
}

function getRandomColor() {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 65%, 55%)`;
}
