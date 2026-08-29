import React, { useState, useEffect } from 'react';
import { Star, Send, CheckCircle2, Heart } from 'lucide-react';
import { api } from '../services/api';
import { Order, CafeSettings } from '../types';
import { getSubmittedFeedbackForOrder, saveSubmittedFeedbackForOrder } from '../utils/deviceOrders';

interface CustomerFeedbackCardProps {
  order: Order;
  settings: CafeSettings;
  onFeedbackSubmitted?: () => void;
}

const PRESET_TAGS = [
  '☕ Kadak Chai',
  '⚡ Fast Service',
  '😋 Delicious Food',
  '🧹 Clean & Hygienic',
  '👨‍🍳 Polite Staff',
  '💰 Great Value',
  '✨ Peaceful Atmosphere',
];

const RATING_LABELS: Record<number, { text: string; hindi: string; emoji: string }> = {
  1: { text: 'Needs Improvement', hindi: 'सुधार की जरूरत', emoji: '😞' },
  2: { text: 'Fair', hindi: 'सामान्य', emoji: '😐' },
  3: { text: 'Good', hindi: 'अच्छा अनुभव', emoji: '🙂' },
  4: { text: 'Very Good', hindi: 'बहुत बढ़िया', emoji: '😊' },
  5: { text: 'Excellent & Delicious!', hindi: 'लाजवाब और स्वादिष्ट!', emoji: '🌟' },
};

export const CustomerFeedbackCard: React.FC<CustomerFeedbackCardProps> = ({
  order,
  settings,
  onFeedbackSubmitted,
}) => {
  const [rating, setRating] = useState<number>(5);
  const [hoverRating, setHoverRating] = useState<number | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [comment, setComment] = useState<string>('');
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [submitted, setSubmitted] = useState<boolean>(false);
  const [submittedData, setSubmittedData] = useState<{ rating: number; comment?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (order?.id) {
      const existing = getSubmittedFeedbackForOrder(order.id);
      if (existing) {
        setSubmitted(true);
        setSubmittedData(existing);
      }
    }
  }, [order?.id]);

  const toggleTag = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (rating < 1 || rating > 5) {
      setError('Please select a star rating between 1 and 5.');
      return;
    }

    try {
      setSubmitting(true);
      setError(null);

      const tagText = selectedTags.length > 0 ? `[${selectedTags.join(', ')}] ` : '';
      const fullComment = `${tagText}${comment.trim()}`.trim();

      await api.submitFeedback({
        orderId: order.id,
        orderNumber: order.orderNumber,
        tableNumber: order.tableNumber,
        tableName: order.tableName,
        customerName: order.customerName || 'Customer',
        rating,
        comment: fullComment,
      });

      saveSubmittedFeedbackForOrder(order.id, rating, fullComment);
      setSubmitted(true);
      setSubmittedData({ rating, comment: fullComment });
      if (onFeedbackSubmitted) {
        onFeedbackSubmitted();
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to submit rating. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const activeRating = hoverRating || rating;

  if (submitted) {
    return (
      <div className="bg-[#1e130c] text-white rounded-lg p-5 sm:p-6 shadow-xs border border-[#3d2618] text-center space-y-3 font-sans">
        <div className="w-10 h-10 rounded-full bg-[#2c190e] text-[#fed7aa] flex items-center justify-center mx-auto border border-[#452c1e]">
          <CheckCircle2 className="w-6 h-6" />
        </div>

        <div>
          <h3 className="text-sm font-semibold text-white flex items-center justify-center gap-1.5">
            <Heart className="w-3.5 h-3.5 text-[#ea580c] fill-[#ea580c]" />
            <span>Thank you for your feedback!</span>
          </h3>
          <p className="text-xs text-[#e2d9d2] mt-0.5">
            Your review for {settings.cafeName} has been received.
          </p>
        </div>

        {submittedData && (
          <div className="bg-[#2a1b12] rounded-md p-3 border border-[#3d2618] max-w-sm mx-auto space-y-1">
            <div className="flex items-center justify-center gap-1">
              {[1, 2, 3, 4, 5].map((star) => (
                <Star
                  key={star}
                  className={`w-4 h-4 ${
                    star <= submittedData.rating
                      ? 'text-[#ea580c] fill-[#ea580c]'
                      : 'text-[#3d2618]'
                  }`}
                />
              ))}
            </div>
            {submittedData.comment && (
              <p className="text-xs text-[#e2d9d2] italic">
                "{submittedData.comment}"
              </p>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="bg-white rounded-lg p-5 border border-[#e7e2dc] shadow-xs space-y-4 font-sans">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[#e7e2dc] pb-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-md bg-[#faf8f5] border border-[#e7e2dc] text-[#ea580c] flex items-center justify-center">
            <Star className="w-3.5 h-3.5 fill-[#ea580c]" />
          </div>
          <div>
            <h4 className="font-semibold text-xs text-[#292524] leading-tight">
              Rate Food & Experience
            </h4>
            <p className="text-[11px] text-[#78716c]">
              Review your visit at {order.tableName}
            </p>
          </div>
        </div>

        <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#faf8f5] border border-[#e7e2dc] text-[#78716c] font-semibold">
          #{order.orderNumber}
        </span>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Interactive Star Picker */}
        <div className="text-center space-y-2 py-1">
          <div className="flex items-center justify-center gap-2">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                type="button"
                key={star}
                onMouseEnter={() => setHoverRating(star)}
                onMouseLeave={() => setHoverRating(null)}
                onClick={() => setRating(star)}
                className="p-1 transform active:scale-110 transition-transform cursor-pointer focus:outline-none"
              >
                <Star
                  className={`w-7 h-7 transition-colors ${
                    star <= activeRating
                      ? 'text-[#ea580c] fill-[#ea580c]'
                      : 'text-[#e7e2dc] hover:text-[#fb923c]'
                  }`}
                />
              </button>
            ))}
          </div>

          {/* Rating Mood Label */}
          {activeRating && (
            <div>
              <span className="text-xs font-semibold text-[#1e130c] bg-[#faf8f5] border border-[#e7e2dc] px-3 py-1 rounded-full inline-flex items-center gap-1.5 shadow-xs">
                <span>{RATING_LABELS[activeRating]?.emoji}</span>
                <span>{RATING_LABELS[activeRating]?.text}</span>
              </span>
            </div>
          )}
        </div>

        {/* Quick Review Tag Chips */}
        <div className="space-y-1.5">
          <label className="text-[11px] font-semibold text-[#78716c] uppercase tracking-wider block">
            What did you like most?
          </label>
          <div className="flex flex-wrap gap-1.5">
            {PRESET_TAGS.map((tag) => {
              const isSelected = selectedTags.includes(tag);
              return (
                <button
                  type="button"
                  key={tag}
                  onClick={() => toggleTag(tag)}
                  className={`px-2.5 py-1 rounded-full text-xs font-semibold transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-[#ea580c] text-white shadow-xs'
                      : 'bg-[#faf8f5] text-[#292524] border border-[#e7e2dc] hover:bg-white hover:border-[#ea580c]'
                  }`}
                >
                  {tag}
                </button>
              );
            })}
          </div>
        </div>

        {/* Comment Textarea */}
        <div className="space-y-1">
          <label className="text-[11px] font-semibold text-[#78716c] uppercase tracking-wider block">
            Review / Suggestions
          </label>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            placeholder="Tell us about the taste, temperature, or service..."
            className="w-full p-2.5 bg-white border border-[#e7e2dc] rounded-md text-xs text-[#292524] placeholder:text-[#a8a29e] focus:border-[#ea580c] focus:outline-none transition-all resize-none"
          />
        </div>

        {error && (
          <p className="text-xs text-red-600 font-medium bg-red-50 p-2 rounded-md border border-red-200">
            {error}
          </p>
        )}

        {/* Submit Button */}
        <button
          type="submit"
          disabled={submitting}
          className="w-full py-2.5 px-4 bg-[#ea580c] hover:bg-[#c2410c] text-white font-bold rounded-md text-xs shadow-xs flex items-center justify-center gap-2 transition-all cursor-pointer disabled:opacity-50"
        >
          <Send className="w-3.5 h-3.5" />
          <span>{submitting ? 'Submitting Review...' : 'Submit Rating'}</span>
        </button>
      </form>
    </div>
  );
};
