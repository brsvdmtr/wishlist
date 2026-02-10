const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export default function Home() {
  return (
    <main>
      <h1>WishList</h1>
      <p className="muted">SaaS wishlist monorepo starter.</p>

      <div className="card">
        <p>
          API URL: <code>{apiUrl}</code>
        </p>
        <p className="muted">Try opening: {apiUrl}/health</p>
      </div>
    </main>
  );
}
