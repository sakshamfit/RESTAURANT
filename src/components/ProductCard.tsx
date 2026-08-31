import React, { useState } from 'react';
import { Plus, Minus, Check, Coffee, UtensilsCrossed, Sparkles } from 'lucide-react';
import { Product, ProductVariant, CartItem } from '../types';

interface ProductCardProps {
  product: Product;
  currency?: string;
  onAddToCart: (item: CartItem) => void;
}

export const ProductCard: React.FC<ProductCardProps> = ({
  product,
  currency = '₹',
  onAddToCart,
}) => {
  const [imageError, setImageError] = useState<boolean>(false);
  // If product has variants, default to first variant
  const [selectedVariant, setSelectedVariant] = useState<ProductVariant | null>(
    product.hasVariants && product.variants && product.variants.length > 0
      ? product.variants[0]
      : null
  );

  const [quantity, setQuantity] = useState<number>(1);
  const [isAddedRecently, setIsAddedRecently] = useState<boolean>(false);

  const currentPrice = product.hasVariants && selectedVariant
    ? selectedVariant.price
    : product.basePrice || 0;

  const handleIncrement = () => setQuantity((q) => Math.min(20, q + 1));
  const handleDecrement = () => setQuantity((q) => Math.max(1, q - 1));

  const handleAdd = () => {
    onAddToCart({
      productId: product.id,
      productName: product.name,
      variantId: selectedVariant?.id,
      variantName: selectedVariant?.name,
      price: currentPrice,
      quantity: quantity,
      image: product.image,
    });

    setIsAddedRecently(true);
    setTimeout(() => setIsAddedRecently(false), 1200);
  };

  const hasValidImage = Boolean(product.image && product.image.trim() !== '' && !imageError);

  const getCategoryIcon = (category: string) => {
    const cat = category.toLowerCase();
    if (cat.includes('tea') || cat.includes('coffee')) {
      return <Coffee className="w-9 h-9 text-[#ea580c]" />;
    }
    return <UtensilsCrossed className="w-9 h-9 text-[#ea580c]" />;
  };

  return (
    <div
      id={`product-card-${product.id}`}
      className={`group bg-white p-5 rounded-xl border border-[#e7e2dc] shadow-xs flex flex-col justify-between hover:border-[#ea580c] transition-all duration-200 ${
        !product.isAvailable ? 'opacity-50 grayscale' : ''
      }`}
    >
      {/* Product Image Banner */}
      <div>
        <div className="h-40 w-full bg-[#fdfbf7] rounded-xl mb-3.5 overflow-hidden relative border border-[#e7e2dc] flex items-center justify-center">
          {hasValidImage ? (
            <img
              src={product.image}
              alt={product.name}
              onError={() => setImageError(true)}
              className="w-full h-full object-cover group-hover:scale-102 transition-transform duration-300"
              loading="lazy"
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center p-4 bg-gradient-to-b from-[#faf8f5] to-[#f4eee6] text-center">
              <div className="w-14 h-14 rounded-2xl bg-white shadow-xs border border-[#e7e2dc] flex items-center justify-center mb-1.5">
                {getCategoryIcon(product.category)}
              </div>
              <span className="text-[11px] font-bold text-[#1e130c] tracking-tight line-clamp-1">
                {product.name}
              </span>
              <span className="text-[9px] font-medium text-[#78716c] uppercase tracking-wider">
                NEXORAOSP RESTAURANT Special
              </span>
            </div>
          )}

          {/* Veg / Non-Veg Badge */}
          <div className="absolute top-2.5 left-2.5 bg-white/95 backdrop-blur-xs px-2 py-0.5 rounded-sm shadow-xs border border-[#e7e2dc] flex items-center gap-1.5">
            {product.isVeg === false ? (
              <>
                <div className="w-2.5 h-2.5 border border-red-600 rounded-xs flex items-center justify-center p-0.5">
                  <div className="w-1 h-1 bg-red-600 rounded-full"></div>
                </div>
                <span className="text-[10px] font-semibold text-red-700 uppercase tracking-tight">Non-Veg</span>
              </>
            ) : (
              <>
                <div className="w-2.5 h-2.5 border border-emerald-600 rounded-xs flex items-center justify-center p-0.5">
                  <div className="w-1 h-1 bg-emerald-600 rounded-full"></div>
                </div>
                <span className="text-[10px] font-semibold text-emerald-700 uppercase tracking-tight">Pure Veg</span>
              </>
            )}
          </div>

          {/* Category Badge */}
          <div className="absolute bottom-2 right-2 bg-white/95 backdrop-blur-xs px-2 py-0.5 rounded-sm text-[10px] font-semibold text-[#1e130c] shadow-xs border border-[#e7e2dc]">
            {product.category}
          </div>

          {/* Unavailable overlay if out of stock */}
          {!product.isAvailable && (
            <div className="absolute inset-0 bg-[#1e130c]/80 flex items-center justify-center">
              <span className="px-3 py-1 bg-red-600 text-white text-xs font-semibold uppercase rounded-md">
                Unavailable
              </span>
            </div>
          )}
        </div>

        {/* Product Title & Description */}
        <h4 className="text-base font-semibold text-[#292524] leading-snug mb-1">
          {product.name}
        </h4>
        <p className="text-xs text-[#78716c] leading-relaxed line-clamp-2 mb-4 font-normal">
          {product.description || 'Prepared fresh upon order.'}
        </p>
      </div>

      <div>
        {/* Variant Selector for Half / Full if applicable */}
        {product.hasVariants && product.variants && product.variants.length > 0 && (
          <div className="flex gap-2 mb-3.5">
            {product.variants.map((variant) => {
              const isSelected = selectedVariant?.id === variant.id;
              return (
                <button
                  key={variant.id}
                  type="button"
                  onClick={() => setSelectedVariant(variant)}
                  disabled={!product.isAvailable}
                  className={`flex-1 py-1.5 px-2 rounded-md text-xs font-semibold transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-[#1e130c] text-white shadow-xs'
                      : 'bg-[#faf8f5] text-[#78716c] border border-[#e7e2dc] hover:bg-white hover:text-[#292524]'
                  }`}
                >
                  <span>{variant.name}</span>
                  <span className="ml-1 opacity-80">({currency}{variant.price})</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Controls: Price + Stepper & Add */}
        <div className="mt-auto pt-3 border-t border-[#e7e2dc] flex items-center justify-between gap-3">
          <span className="text-lg font-bold text-[#1e130c] tracking-tight">
            {currency}{currentPrice}
          </span>

          <div className="flex items-center gap-2">
            {/* Stepper */}
            <div className="flex items-center bg-[#faf8f5] rounded-md p-0.5 gap-1.5 border border-[#e7e2dc]">
              <button
                type="button"
                onClick={handleDecrement}
                disabled={!product.isAvailable || quantity <= 1}
                className="w-6 h-6 flex items-center justify-center bg-white rounded-sm shadow-xs font-bold text-[#292524] disabled:opacity-30 hover:bg-[#faf8f5] transition-colors cursor-pointer"
                aria-label="Decrease quantity"
              >
                <Minus className="w-3 h-3" />
              </button>
              <span className="font-semibold text-xs text-[#292524] w-4 text-center">
                {quantity}
              </span>
              <button
                type="button"
                onClick={handleIncrement}
                disabled={!product.isAvailable || quantity >= 20}
                className="w-6 h-6 flex items-center justify-center bg-white rounded-sm shadow-xs font-bold text-[#ea580c] disabled:opacity-30 hover:bg-[#faf8f5] transition-colors cursor-pointer"
                aria-label="Increase quantity"
              >
                <Plus className="w-3 h-3" />
              </button>
            </div>

            {/* Add Button */}
            <button
              type="button"
              id={`add-btn-${product.id}`}
              onClick={handleAdd}
              disabled={!product.isAvailable}
              className={`px-4 py-2 rounded-md font-bold text-xs shadow-xs transition-all active:scale-98 flex items-center gap-1.5 cursor-pointer ${
                isAddedRecently
                  ? 'bg-emerald-600 text-white'
                  : 'bg-[#ea580c] hover:bg-[#c2410c] text-white'
              } disabled:bg-[#e7e2dc] disabled:text-[#a8a29e] disabled:shadow-none`}
            >
              {isAddedRecently ? (
                <>
                  <Check className="w-3.5 h-3.5" />
                  <span>Added</span>
                </>
              ) : (
                <span>ADD</span>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

