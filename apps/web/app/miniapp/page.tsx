import MiniApp from './MiniApp';

export default function MiniAppPage() {
  return (
    <MiniApp
      apiBase={(process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001').replace(/\/+$/, '')}
      botUsername={process.env.NEXT_PUBLIC_BOT_USERNAME ?? ''}
    />
  );
}
