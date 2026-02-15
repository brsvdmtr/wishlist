'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  getWishlist,
  updateWishlist,
  deleteWishlist,
  createItem,
  updateItem,
  deleteItem,
  createTag,
  deleteTag,
  type Wishlist,
  type Item,
  type Tag,
} from '@/lib/admin-api-client';

type Props = {
  params: { id: string };
};

export default function EditWishlistPage({ params }: Props) {
  const router = useRouter();
  const wishlistId = params.id;

  const [wishlist, setWishlist] = useState<Wishlist | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Edit wishlist modal
  const [showEditWishlist, setShowEditWishlist] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [saving, setSaving] = useState(false);

  // Add item modal
  const [showAddItem, setShowAddItem] = useState(false);
  const [newItemTitle, setNewItemTitle] = useState('');
  const [newItemUrl, setNewItemUrl] = useState('');
  const [newItemPrice, setNewItemPrice] = useState('');
  const [newItemComment, setNewItemComment] = useState('');
  const [addingItem, setAddingItem] = useState(false);

  // Add tag modal
  const [showAddTag, setShowAddTag] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [addingTag, setAddingTag] = useState(false);

  const load = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getWishlist(wishlistId);
      setWishlist(data.wishlist);
      setItems(data.items);
      setTags(data.tags);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load wishlist');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [wishlistId]);

  const handleEditWishlist = async () => {
    if (!wishlist) return;

    setSaving(true);
    try {
      const { wishlist: updated } = await updateWishlist(wishlist.id, {
        title: editTitle.trim(),
        description: editDescription.trim() || null,
      });
      setWishlist(updated);
      setShowEditWishlist(false);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to update wishlist');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteWishlist = async () => {
    if (!wishlist) return;
    if (!confirm(`Delete wishlist "${wishlist.title}"? This cannot be undone.`)) return;

    try {
      await deleteWishlist(wishlist.id);
      router.push('/admin');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete wishlist');
    }
  };

  const handleAddItem = async () => {
    if (!newItemTitle.trim() || !newItemUrl.trim()) return;

    setAddingItem(true);
    try {
      await createItem(wishlistId, {
        title: newItemTitle.trim(),
        url: newItemUrl.trim(),
        priceText: newItemPrice.trim() || undefined,
        commentOwner: newItemComment.trim() || undefined,
      });

      await load();
      setShowAddItem(false);
      setNewItemTitle('');
      setNewItemUrl('');
      setNewItemPrice('');
      setNewItemComment('');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to add item');
    } finally {
      setAddingItem(false);
    }
  };

  const handleDeleteItem = async (itemId: string) => {
    if (!confirm('Delete this item?')) return;

    try {
      await deleteItem(itemId);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete item');
    }
  };

  const handleAddTag = async () => {
    if (!newTagName.trim()) return;

    setAddingTag(true);
    try {
      await createTag(wishlistId, { name: newTagName.trim() });
      await load();
      setShowAddTag(false);
      setNewTagName('');
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to add tag');
    } finally {
      setAddingTag(false);
    }
  };

  const handleDeleteTag = async (tagId: string) => {
    if (!confirm('Delete this tag?')) return;

    try {
      await deleteTag(tagId);
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete tag');
    }
  };

  if (loading) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-6">
        <div className="mx-auto max-w-6xl">
          <p className="text-slate-600">Loading...</p>
        </div>
      </main>
    );
  }

  if (error || !wishlist) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-6">
        <div className="mx-auto max-w-6xl">
          <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800">
            <strong>Error:</strong> {error || 'Wishlist not found'}
          </div>
          <Link href="/admin" className="mt-4 inline-block text-cyan-700 hover:underline">
            ← Back to dashboard
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100 p-6">
      <div className="mx-auto max-w-6xl">
        <header className="mb-8">
          <Link
            href="/admin"
            className="inline-flex items-center text-sm text-slate-600 hover:text-cyan-700"
          >
            ← Back to dashboard
          </Link>

          <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="font-display text-3xl font-bold tracking-tight text-slate-900">
                {wishlist.title}
              </h1>
              {wishlist.description && <p className="mt-2 text-slate-600">{wishlist.description}</p>}
              <p className="mt-2 text-sm text-slate-500">
                Public URL:{' '}
                <Link
                  href={`/w/${wishlist.slug}`}
                  target="_blank"
                  className="font-mono text-cyan-700 hover:underline"
                >
                  /w/{wishlist.slug}
                </Link>
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => {
                  setEditTitle(wishlist.title);
                  setEditDescription(wishlist.description ?? '');
                  setShowEditWishlist(true);
                }}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-50"
              >
                Edit Info
              </button>
              <button
                onClick={handleDeleteWishlist}
                className="rounded-xl border border-rose-200 bg-white px-4 py-2 text-sm font-semibold text-rose-700 transition hover:bg-rose-50"
              >
                Delete Wishlist
              </button>
            </div>
          </div>
        </header>

        {/* Tags Section */}
        <section className="mb-8">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-slate-900">Tags ({tags.length})</h2>
            <button
              onClick={() => setShowAddTag(true)}
              className="rounded-xl bg-cyan-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-cyan-800"
            >
              + Add Tag
            </button>
          </div>

          {tags.length === 0 ? (
            <p className="text-slate-600">No tags yet.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => (
                <div
                  key={tag.id}
                  className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-4 py-2 text-sm"
                >
                  <span className="font-medium text-slate-900">{tag.name}</span>
                  <button
                    onClick={() => handleDeleteTag(tag.id)}
                    className="text-slate-500 hover:text-rose-600"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Items Section */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-slate-900">Items ({items.length})</h2>
            <button
              onClick={() => setShowAddItem(true)}
              className="rounded-xl bg-cyan-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-cyan-800"
            >
              + Add Item
            </button>
          </div>

          {items.length === 0 ? (
            <p className="text-slate-600">No items yet.</p>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {items.map((item) => (
                <article
                  key={item.id}
                  className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noreferrer"
                        className="block truncate text-lg font-semibold text-slate-900 hover:underline"
                      >
                        {item.title}
                      </a>
                      {item.priceText && (
                        <p className="mt-1 text-sm text-slate-600">{item.priceText}</p>
                      )}
                    </div>

                    <span
                      className={`shrink-0 inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ring-1 ${
                        item.status === 'AVAILABLE'
                          ? 'bg-emerald-50 text-emerald-700 ring-emerald-200'
                          : item.status === 'RESERVED'
                            ? 'bg-amber-50 text-amber-800 ring-amber-200'
                            : 'bg-slate-100 text-slate-700 ring-slate-200'
                      }`}
                    >
                      {item.status}
                    </span>
                  </div>

                  {item.tags && item.tags.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {item.tags.map((tag) => (
                        <span
                          key={tag.id}
                          className="inline-flex items-center rounded-full border border-slate-200 px-3 py-1 text-xs font-medium text-slate-700"
                        >
                          {tag.name}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="mt-4 flex gap-2">
                    <button
                      onClick={() => handleDeleteItem(item.id)}
                      className="rounded-xl border border-rose-200 bg-white px-4 py-2 text-sm font-semibold text-rose-700 transition hover:bg-rose-50"
                    >
                      Delete
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        {/* Edit Wishlist Modal */}
        {showEditWishlist && (
          <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-6 backdrop-blur-sm">
            <div className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-6 shadow-lg">
              <h3 className="text-xl font-semibold text-slate-900">Edit Wishlist</h3>

              <div className="mt-4 grid gap-4">
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-slate-900">Title</span>
                  <input
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    className="rounded-xl border border-slate-200 px-4 py-3"
                  />
                </label>

                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-slate-900">Description</span>
                  <textarea
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    rows={4}
                    className="resize-none rounded-xl border border-slate-200 px-4 py-3"
                  />
                </label>
              </div>

              <div className="mt-6 flex justify-end gap-2">
                <button
                  onClick={() => setShowEditWishlist(false)}
                  disabled={saving}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleEditWishlist}
                  disabled={saving || !editTitle.trim()}
                  className="rounded-xl bg-cyan-700 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-800 disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Add Item Modal */}
        {showAddItem && (
          <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-6 backdrop-blur-sm">
            <div className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-6 shadow-lg">
              <h3 className="text-xl font-semibold text-slate-900">Add Item</h3>

              <div className="mt-4 grid gap-4">
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-slate-900">
                    Title <span className="text-rose-600">*</span>
                  </span>
                  <input
                    type="text"
                    value={newItemTitle}
                    onChange={(e) => setNewItemTitle(e.target.value)}
                    placeholder="Coffee beans (1kg)"
                    className="rounded-xl border border-slate-200 px-4 py-3"
                  />
                </label>

                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-slate-900">
                    URL <span className="text-rose-600">*</span>
                  </span>
                  <input
                    type="url"
                    value={newItemUrl}
                    onChange={(e) => setNewItemUrl(e.target.value)}
                    placeholder="https://example.com/product"
                    className="rounded-xl border border-slate-200 px-4 py-3"
                  />
                </label>

                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-slate-900">Price (optional)</span>
                  <input
                    type="text"
                    value={newItemPrice}
                    onChange={(e) => setNewItemPrice(e.target.value)}
                    placeholder="≈ 1 500 ₽"
                    className="rounded-xl border border-slate-200 px-4 py-3"
                  />
                </label>

                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-slate-900">Comment (optional)</span>
                  <textarea
                    value={newItemComment}
                    onChange={(e) => setNewItemComment(e.target.value)}
                    rows={3}
                    placeholder="Any notes for gift-givers..."
                    className="resize-none rounded-xl border border-slate-200 px-4 py-3"
                  />
                </label>
              </div>

              <div className="mt-6 flex justify-end gap-2">
                <button
                  onClick={() => setShowAddItem(false)}
                  disabled={addingItem}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddItem}
                  disabled={addingItem || !newItemTitle.trim() || !newItemUrl.trim()}
                  className="rounded-xl bg-cyan-700 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-800 disabled:opacity-50"
                >
                  {addingItem ? 'Adding...' : 'Add Item'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Add Tag Modal */}
        {showAddTag && (
          <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-6 backdrop-blur-sm">
            <div className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-6 shadow-lg">
              <h3 className="text-xl font-semibold text-slate-900">Add Tag</h3>

              <div className="mt-4">
                <label className="grid gap-2">
                  <span className="text-sm font-semibold text-slate-900">
                    Name <span className="text-rose-600">*</span>
                  </span>
                  <input
                    type="text"
                    value={newTagName}
                    onChange={(e) => setNewTagName(e.target.value)}
                    placeholder="electronics"
                    maxLength={64}
                    className="rounded-xl border border-slate-200 px-4 py-3"
                  />
                </label>
              </div>

              <div className="mt-6 flex justify-end gap-2">
                <button
                  onClick={() => setShowAddTag(false)}
                  disabled={addingTag}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-900 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleAddTag}
                  disabled={addingTag || !newTagName.trim()}
                  className="rounded-xl bg-cyan-700 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-800 disabled:opacity-50"
                >
                  {addingTag ? 'Adding...' : 'Add Tag'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
