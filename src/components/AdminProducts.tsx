import React, { useState } from 'react';
import { Plus, Edit2, Trash2, Eye, EyeOff, Image as ImageIcon, Check, X, AlertCircle, Upload, Link, Coffee, UtensilsCrossed } from 'lucide-react';
import { Product, ProductVariant, CafeCategory, CafeSettings } from '../types';
import { api } from '../services/api';

interface AdminProductsProps {
  products: Product[];
  categories: CafeCategory[];
  settings: CafeSettings;
  onRefresh: () => void;
}

export const AdminProducts: React.FC<AdminProductsProps> = ({
  products,
  categories,
  settings,
  onRefresh,
}) => {
  const [isModalOpen, setIsModalOpen] = useState<boolean>(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);

  // Form states
  const [name, setName] = useState<string>('');
  const [description, setDescription] = useState<string>('');
  const [category, setCategory] = useState<string>(categories[0]?.name || 'Snacks');
  const [image, setImage] = useState<string>('');
  const [imageUrlInput, setImageUrlInput] = useState<string>('');
  const [hasVariants, setHasVariants] = useState<boolean>(false);
  const [isVeg, setIsVeg] = useState<boolean>(true);
  const [basePrice, setBasePrice] = useState<number>(10);
  const [variants, setVariants] = useState<ProductVariant[]>([
    { id: 'var-1', name: 'Half', price: 80 },
    { id: 'var-2', name: 'Full', price: 150 },
  ]);
  const [isAvailable, setIsAvailable] = useState<boolean>(true);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState<boolean>(false);

  const handleOpenAdd = () => {
    setEditingProduct(null);
    setName('');
    setDescription('');
    setCategory(categories[0]?.name || 'Snacks');
    setImage('');
    setImageUrlInput('');
    setHasVariants(false);
    setIsVeg(true);
    setBasePrice(10);
    setVariants([
      { id: 'var-1', name: 'Half', price: 80 },
      { id: 'var-2', name: 'Full', price: 150 },
    ]);
    setIsAvailable(true);
    setFormError(null);
    setIsModalOpen(true);
  };

  const handleOpenEdit = (product: Product) => {
    setEditingProduct(product);
    setName(product.name);
    setDescription(product.description);
    setCategory(product.category);
    setImage(product.image || '');
    setImageUrlInput(product.image || '');
    setHasVariants(product.hasVariants);
    setIsVeg(product.isVeg !== false);
    setBasePrice(product.basePrice || 0);
    setVariants(
      product.variants && product.variants.length > 0
        ? product.variants
        : [
            { id: 'var-1', name: 'Half', price: 80 },
            { id: 'var-2', name: 'Full', price: 150 },
          ]
    );
    setIsAvailable(product.isAvailable);
    setFormError(null);
    setIsModalOpen(true);
  };

  const handleToggleAvailability = async (productId: string) => {
    try {
      await api.adminToggleProductAvailability(productId);
      onRefresh();
    } catch (err: any) {
      alert(err?.message || 'Failed to toggle availability');
    }
  };

  const handleDelete = async (productId: string, productName: string) => {
    if (!window.confirm(`Are you sure you want to delete "${productName}" from the menu?`)) {
      return;
    }
    try {
      await api.adminDeleteProduct(productId);
      onRefresh();
    } catch (err: any) {
      alert(err?.message || 'Failed to delete product');
    }
  };

  const handleVariantChange = (index: number, field: 'name' | 'price', value: string | number) => {
    setVariants((prev) => {
      const updated = [...prev];
      if (field === 'price') {
        updated[index] = { ...updated[index], price: Number(value) || 0 };
      } else {
        updated[index] = { ...updated[index], name: String(value) };
      }
      return updated;
    });
  };

  const handleAddVariant = () => {
    setVariants((prev) => [...prev, { id: `var-${Date.now()}`, name: 'Large', price: 100 }]);
  };

  const handleRemoveVariant = (index: number) => {
    setVariants((prev) => prev.filter((_, i) => i !== index));
  };

  const handleApplyUrl = () => {
    if (imageUrlInput.trim()) {
      setImage(imageUrlInput.trim());
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setFormError('Product name is required.');
      return;
    }

    if (hasVariants && variants.length === 0) {
      setFormError('Please add at least one variant or switch to Single Price.');
      return;
    }

    setSaving(true);
    setFormError(null);

    const payload = {
      name: name.trim(),
      description: description.trim(),
      category: category.trim(),
      image: image.trim(),
      hasVariants,
      isVeg,
      basePrice: hasVariants ? undefined : Number(basePrice),
      variants: hasVariants ? variants : undefined,
      isAvailable,
    };

    try {
      if (editingProduct) {
        await api.adminEditProduct(editingProduct.id, payload);
      } else {
        await api.adminAddProduct(payload);
      }
      setIsModalOpen(false);
      onRefresh();
    } catch (err: any) {
      setFormError(err?.message || 'Failed to save product');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4 font-sans text-[#1e130c]">
      {/* Header Bar */}
      <div className="bg-white p-4 sm:p-5 rounded-2xl border border-[#e7e2dc] shadow-xs flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-bold text-base sm:text-lg text-[#1e130c] leading-tight">
            Menu & Product Management
          </h2>
          <p className="text-xs text-[#6b5d52] mt-0.5">
            Owner can manually paste photo URLs or upload images from phone/PC. Changes immediately update customer menu.
          </p>
        </div>

        <button
          onClick={handleOpenAdd}
          className="py-2.5 px-4 bg-[#ea580c] hover:bg-[#c2410c] text-white font-bold text-xs sm:text-sm rounded-xl flex items-center gap-1.5 shadow-sm transition-colors cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Add New Product</span>
        </button>
      </div>

      {/* Products Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {products.map((product) => (
          <div
            key={product.id}
            className={`bg-white rounded-2xl border transition-all duration-200 shadow-xs overflow-hidden flex flex-col justify-between ${
              !product.isAvailable ? 'border-stone-300 opacity-75' : 'border-[#e7e2dc]'
            }`}
          >
            {/* Image Header / Fallback Placeholder */}
            <div className="relative h-40 bg-[#faf8f5] overflow-hidden flex items-center justify-center border-b border-[#e7e2dc]">
              {product.image ? (
                <img
                  src={product.image}
                  alt={product.name}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex flex-col items-center justify-center p-4 bg-gradient-to-b from-[#faf8f5] to-[#f0ebe1] text-center space-y-1.5">
                  <div className="w-11 h-11 rounded-xl bg-white shadow-xs border border-[#e7e2dc] flex items-center justify-center text-[#ea580c]">
                    {product.category.toLowerCase().includes('tea') || product.category.toLowerCase().includes('coffee') ? (
                      <Coffee className="w-6 h-6" />
                    ) : (
                      <UtensilsCrossed className="w-6 h-6" />
                    )}
                  </div>
                  <span className="text-[11px] font-bold text-[#6b5d52]">
                    No Photo Uploaded
                  </span>
                  <button
                    type="button"
                    onClick={() => handleOpenEdit(product)}
                    className="px-2.5 py-1 bg-white hover:bg-[#f0ebe1] text-[#ea580c] text-[10px] font-bold rounded-lg border border-[#e7e2dc] shadow-xs cursor-pointer"
                  >
                    + Paste / Upload Photo
                  </button>
                </div>
              )}

              {/* Badges */}
              <div className="absolute top-2 left-2 flex items-center gap-1.5">
                <div className="bg-white/95 backdrop-blur-xs px-2 py-0.5 rounded-md text-[10px] font-bold text-[#1e130c] uppercase shadow-xs border border-[#e7e2dc]">
                  {product.category}
                </div>
                {product.isVeg === false ? (
                  <div className="bg-white/95 px-1.5 py-0.5 rounded-md text-[10px] font-bold text-red-700 uppercase flex items-center gap-1 shadow-xs border border-red-200">
                    <span className="w-2 h-2 rounded-full bg-red-600"></span>
                    <span>Non-Veg</span>
                  </div>
                ) : (
                  <div className="bg-white/95 px-1.5 py-0.5 rounded-md text-[10px] font-bold text-emerald-700 uppercase flex items-center gap-1 shadow-xs border border-emerald-200">
                    <span className="w-2 h-2 rounded-full bg-emerald-600"></span>
                    <span>Pure Veg</span>
                  </div>
                )}
              </div>

              {/* Quick Availability Badge */}
              <div className="absolute top-2 right-2">
                <button
                  onClick={() => handleToggleAvailability(product.id)}
                  className={`px-2.5 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 shadow-sm transition-colors cursor-pointer ${
                    product.isAvailable
                      ? 'bg-emerald-600 text-white'
                      : 'bg-red-600 text-white'
                  }`}
                >
                  {product.isAvailable ? <Eye className="w-3 h-3" /> : <EyeOff className="w-3 h-3" />}
                  <span>{product.isAvailable ? 'Available' : 'Unavailable'}</span>
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="p-4 flex-1 flex flex-col justify-between space-y-3">
              <div>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-bold text-base text-[#1e130c]">{product.name}</h3>
                  <div className="text-right">
                    {product.hasVariants && product.variants ? (
                      <span className="text-xs font-bold text-[#ea580c]">
                        {product.variants.map((v) => `${v.name}: ${settings.currency}${v.price}`).join(' | ')}
                      </span>
                    ) : (
                      <span className="text-base font-black text-[#1e130c]">
                        {settings.currency}{product.basePrice}
                      </span>
                    )}
                  </div>
                </div>

                <p className="text-xs text-[#6b5d52] line-clamp-2 mt-1">
                  {product.description || 'No description provided.'}
                </p>
              </div>

              {/* Action Buttons */}
              <div className="pt-2 border-t border-[#e7e2dc] flex items-center justify-between">
                <span className="text-[10px] font-semibold text-[#6b5d52]">
                  {product.image ? '✓ Photo Ready' : '⚠️ Missing Photo'}
                </span>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleOpenEdit(product)}
                    className="py-1.5 px-3 bg-[#faf8f5] hover:bg-[#f0ebe1] text-[#1e130c] rounded-xl text-xs font-bold flex items-center gap-1 border border-[#e7e2dc] transition-colors cursor-pointer"
                  >
                    <Edit2 className="w-3.5 h-3.5 text-[#ea580c]" />
                    <span>Edit</span>
                  </button>

                  <button
                    onClick={() => handleDelete(product.id, product.name)}
                    className="py-1.5 px-3 bg-red-50 hover:bg-red-100 text-red-600 rounded-xl text-xs font-bold flex items-center gap-1 border border-red-200 transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Add / Edit Product Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-stone-950/75 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-lg rounded-3xl shadow-2xl overflow-hidden border border-[#e7e2dc] my-8">
            <div className="p-4 sm:p-5 bg-[#1e130c] text-white flex items-center justify-between border-b border-[#3a291e]">
              <h2 className="font-bold text-base sm:text-lg">
                {editingProduct ? `Edit ${editingProduct.name}` : 'Add New Menu Item'}
              </h2>
              <button
                onClick={() => setIsModalOpen(false)}
                className="p-1.5 text-[#a89f91] hover:text-white rounded-xl cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleSave} className="p-5 space-y-4 max-h-[80vh] overflow-y-auto bg-[#faf8f5]">
              {formError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-700 text-xs font-semibold flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 text-red-500" />
                  <span>{formError}</span>
                </div>
              )}

              {/* Product Name */}
              <div>
                <label className="block text-xs font-bold text-[#1e130c] mb-1">
                  Product Name *
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Special Masala Chai, Crispy Samosa, Veg Momos"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3.5 py-2.5 bg-white border border-[#e7e2dc] rounded-xl text-sm font-medium text-[#1e130c] placeholder:text-[#a89f91] focus:outline-none focus:border-[#ea580c]"
                />
              </div>

              {/* Veg / Non-Veg Type Selection */}
              <div>
                <label className="block text-xs font-bold text-[#1e130c] mb-1">
                  Dietary Classification (Veg / Non-Veg) *
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setIsVeg(true)}
                    className={`py-2 px-3 rounded-xl text-xs font-bold border transition-all flex items-center justify-center gap-2 cursor-pointer ${
                      isVeg
                        ? 'bg-emerald-600 text-white border-emerald-700 shadow-sm'
                        : 'bg-white text-[#6b5d52] border-[#e7e2dc] hover:bg-[#f0ebe1]'
                    }`}
                  >
                    <div className="w-3 h-3 border-2 border-current rounded-xs flex items-center justify-center">
                      <div className="w-1.5 h-1.5 bg-current rounded-full"></div>
                    </div>
                    <span>Pure Veg 🟢</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setIsVeg(false)}
                    className={`py-2 px-3 rounded-xl text-xs font-bold border transition-all flex items-center justify-center gap-2 cursor-pointer ${
                      !isVeg
                        ? 'bg-red-600 text-white border-red-700 shadow-sm'
                        : 'bg-white text-[#6b5d52] border-[#e7e2dc] hover:bg-[#f0ebe1]'
                    }`}
                  >
                    <div className="w-3 h-3 border-2 border-current rounded-xs flex items-center justify-center">
                      <div className="w-1.5 h-1.5 bg-current rounded-full"></div>
                    </div>
                    <span>Non-Veg 🔴</span>
                  </button>
                </div>
              </div>

              {/* Category & Availability */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-bold text-[#1e130c] mb-1">
                    Category *
                  </label>
                  <select
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    className="w-full px-3 py-2.5 bg-white border border-[#e7e2dc] rounded-xl text-xs font-semibold text-[#1e130c] focus:outline-none focus:border-[#ea580c]"
                  >
                    {categories.map((cat) => (
                      <option key={cat.id} value={cat.name}>
                        {cat.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-[#1e130c] mb-1">
                    Status
                  </label>
                  <button
                    type="button"
                    onClick={() => setIsAvailable(!isAvailable)}
                    className={`w-full py-2.5 px-3 rounded-xl text-xs font-bold border transition-colors flex items-center justify-center gap-1.5 cursor-pointer ${
                      isAvailable
                        ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                        : 'bg-red-50 text-red-800 border-red-300'
                    }`}
                  >
                    {isAvailable ? <Check className="w-3.5 h-3.5" /> : <X className="w-3.5 h-3.5" />}
                    <span>{isAvailable ? 'Available' : 'Unavailable'}</span>
                  </button>
                </div>
              </div>

              {/* Description */}
              <div>
                <label className="block text-xs font-bold text-[#1e130c] mb-1">
                  Description
                </label>
                <textarea
                  rows={2}
                  placeholder="Ingredients, taste, spices, etc."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full px-3.5 py-2 bg-white border border-[#e7e2dc] rounded-xl text-xs font-medium text-[#1e130c] placeholder:text-[#a89f91] focus:outline-none focus:border-[#ea580c]"
                />
              </div>

              {/* Pricing Architecture */}
              <div className="p-3.5 bg-white rounded-2xl border border-[#e7e2dc] space-y-3 shadow-xs">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold text-[#1e130c]">Pricing Structure:</span>
                  <div className="flex items-center gap-1 bg-[#faf8f5] p-1 rounded-xl border border-[#e7e2dc]">
                    <button
                      type="button"
                      onClick={() => setHasVariants(false)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                        !hasVariants ? 'bg-[#1e130c] text-white shadow-xs' : 'text-[#6b5d52] hover:text-[#1e130c]'
                      }`}
                    >
                      Single Price
                    </button>
                    <button
                      type="button"
                      onClick={() => setHasVariants(true)}
                      className={`px-2.5 py-1 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                        hasVariants ? 'bg-[#1e130c] text-white shadow-xs' : 'text-[#6b5d52] hover:text-[#1e130c]'
                      }`}
                    >
                      Half / Full (Variants)
                    </button>
                  </div>
                </div>

                {!hasVariants ? (
                  <div>
                    <label className="block text-xs font-semibold text-[#6b5d52] mb-1">
                      Base Price ({settings.currency})
                    </label>
                    <input
                      type="number"
                      min={1}
                      value={basePrice}
                      onChange={(e) => setBasePrice(Number(e.target.value) || 0)}
                      className="w-full px-3 py-2 bg-[#faf8f5] border border-[#e7e2dc] rounded-xl text-sm font-bold text-[#1e130c] focus:outline-none focus:border-[#ea580c]"
                    />
                  </div>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-[11px] font-bold text-[#6b5d52]">
                      <span>Variant Name</span>
                      <span>Price ({settings.currency})</span>
                    </div>
                    {variants.map((variant, idx) => (
                      <div key={variant.id || idx} className="flex items-center gap-2">
                        <input
                          type="text"
                          value={variant.name}
                          onChange={(e) => handleVariantChange(idx, 'name', e.target.value)}
                          placeholder="e.g. Half, Full"
                          className="flex-1 px-3 py-1.5 bg-[#faf8f5] border border-[#e7e2dc] rounded-xl text-xs font-semibold text-[#1e130c]"
                        />
                        <input
                          type="number"
                          value={variant.price}
                          onChange={(e) => handleVariantChange(idx, 'price', e.target.value)}
                          className="w-24 px-3 py-1.5 bg-[#faf8f5] border border-[#e7e2dc] rounded-xl text-xs font-bold text-[#1e130c] text-right"
                        />
                        <button
                          type="button"
                          onClick={() => handleRemoveVariant(idx)}
                          className="p-1.5 text-[#a89f91] hover:text-red-600 cursor-pointer"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={handleAddVariant}
                      className="text-xs font-bold text-[#ea580c] hover:text-[#c2410c] flex items-center gap-1 pt-1 cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add Another Size Variant</span>
                    </button>
                  </div>
                )}
              </div>

              {/* Food Image: Paste URL & File Upload */}
              <div className="space-y-3 p-4 bg-white rounded-2xl border border-[#e7e2dc] shadow-xs">
                <label className="block text-xs font-bold text-[#1e130c] flex items-center justify-between">
                  <span className="flex items-center gap-1.5">
                    <ImageIcon className="w-4 h-4 text-[#ea580c]" />
                    <span>Food Photo (Paste URL or Upload from Device)</span>
                  </span>
                  {image ? (
                    <span className="text-[10px] text-emerald-600 font-bold">✓ Photo Set</span>
                  ) : (
                    <span className="text-[10px] text-[#a89f91] font-medium">Optional (No Photo)</span>
                  )}
                </label>

                {/* Live Preview Box if set */}
                {image ? (
                  <div className="flex items-center gap-3 p-3 bg-[#faf8f5] rounded-xl border border-[#e7e2dc]">
                    <div className="w-16 h-16 rounded-xl overflow-hidden border border-[#e7e2dc] shrink-0 bg-white">
                      <img src={image} alt="Preview" className="w-full h-full object-cover" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-bold text-[#1e130c] truncate">Active Photo</p>
                      <p className="text-[11px] text-[#6b5d52] truncate max-w-xs">{image}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setImage('');
                        setImageUrlInput('');
                      }}
                      className="py-1.5 px-3 bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 rounded-xl text-xs font-bold cursor-pointer"
                    >
                      Remove
                    </button>
                  </div>
                ) : (
                  <div className="p-3 bg-[#faf8f5] rounded-xl border border-dashed border-[#e7e2dc] text-center">
                    <p className="text-xs font-medium text-[#6b5d52]">
                      No photo attached. Choose one of the two options below:
                    </p>
                  </div>
                )}

                {/* Option 1: Paste URL */}
                <div className="space-y-1.5">
                  <label className="block text-[11px] font-bold text-[#6b5d52] flex items-center gap-1">
                    <Link className="w-3 h-3 text-[#ea580c]" />
                    <span>Option A: Paste Direct Image Link (URL)</span>
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="url"
                      placeholder="https://example.com/my-tea-photo.jpg"
                      value={imageUrlInput}
                      onChange={(e) => setImageUrlInput(e.target.value)}
                      className="flex-1 px-3 py-2 bg-[#faf8f5] border border-[#e7e2dc] rounded-xl text-xs text-[#1e130c] placeholder:text-[#a89f91] focus:outline-none focus:border-[#ea580c]"
                    />
                    <button
                      type="button"
                      onClick={handleApplyUrl}
                      className="px-3.5 py-2 bg-[#1e130c] hover:bg-[#2a1b12] text-white rounded-xl text-xs font-bold cursor-pointer shadow-xs transition-colors"
                    >
                      Apply URL
                    </button>
                  </div>
                </div>

                {/* Option 2: Upload File / Take Picture */}
                <div className="pt-2 border-t border-[#e7e2dc] space-y-1.5">
                  <label className="block text-[11px] font-bold text-[#6b5d52] flex items-center gap-1">
                    <Upload className="w-3 h-3 text-[#ea580c]" />
                    <span>Option B: Upload Photo from Phone / PC</span>
                  </label>

                  <label className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-[#faf8f5] hover:bg-[#f0ebe1] border border-dashed border-[#e7e2dc] rounded-xl text-xs font-bold text-[#1e130c] cursor-pointer transition-colors">
                    <Upload className="w-3.5 h-3.5 text-[#ea580c]" />
                    <span>{image ? 'Replace Photo from Gallery / Files' : 'Select Photo from Phone / PC'}</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          const reader = new FileReader();
                          reader.onload = (event) => {
                            const img = new window.Image();
                            img.onload = () => {
                              const canvas = document.createElement('canvas');
                              const maxDim = 800;
                              let width = img.width;
                              let height = img.height;
                              if (width > height && width > maxDim) {
                                height = Math.round((height * maxDim) / width);
                                width = maxDim;
                              } else if (height > maxDim) {
                                width = Math.round((width * maxDim) / height);
                                height = maxDim;
                              }
                              canvas.width = width;
                              canvas.height = height;
                              const ctx = canvas.getContext('2d');
                              ctx?.drawImage(img, 0, 0, width, height);
                              const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
                              setImage(dataUrl);
                              setImageUrlInput(dataUrl);
                            };
                            img.src = event.target?.result as string;
                          };
                          reader.readAsDataURL(file);
                        }
                      }}
                    />
                  </label>
                  <p className="text-[10px] text-[#a89f91] text-center">
                    Auto-optimized to lightweight format for instantaneous customer mobile loading.
                  </p>
                </div>
              </div>

              {/* Actions */}
              <div className="pt-3 border-t border-[#e7e2dc] flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="py-2.5 px-4 bg-white hover:bg-[#f0ebe1] text-[#6b5d52] border border-[#e7e2dc] rounded-xl text-xs font-bold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="py-2.5 px-5 bg-[#ea580c] hover:bg-[#c2410c] text-white rounded-xl text-xs font-bold shadow-md cursor-pointer disabled:bg-[#a89f91]"
                >
                  {saving ? 'Saving...' : editingProduct ? 'Update Product' : 'Add to Menu'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

