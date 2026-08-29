import React, { useState, useEffect } from 'react';
import { Star, MessageSquare, RefreshCw, Sparkles, User, MapPin, Award, ThumbsUp } from 'lucide-react';
import { CustomerFeedback } from '../types';
import { api } from '../services/api';
import { subscribeToFeedbacks } from '../lib/firebase';

export const AdminFeedbacks: React.FC = () => {
  const [feedbacks, setFeedbacks] = useState<CustomerFeedback[]>([]);
  const [averageRating, setAverageRating] = useState<number>(0);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [distribution, setDistribution] = useState<Record<number, number>>({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
  const [filterRating, setFilterRating] = useState<number | 'all'>('all');
  const [loading, setLoading] = useState<boolean>(true);

  const calculateStats = (list: CustomerFeedback[]) => {
    if (!list || list.length === 0) {
      setAverageRating(0);
      setTotalCount(0);
      setDistribution({ 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 });
      return;
    }
    const sum = list.reduce((acc, f) => acc + (f.rating || 5), 0);
    const avg = sum / list.length;
    const dist: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    list.forEach((f) => {
      const r = Math.min(5, Math.max(1, Math.round(f.rating || 5)));
      dist[r] = (dist[r] || 0) + 1;
    });
    setAverageRating(Number(avg.toFixed(1)));
    setTotalCount(list.length);
    setDistribution(dist);
  };

  const fetchFeedbacks = async (isInitial = false) => {
    try {
      if (isInitial) setLoading(true);
      const res = await api.adminGetFeedbacks();
      const list = res.feedbacks || [];
      setFeedbacks(list);
      calculateStats(list);
    } catch (err) {
      console.error('Failed to load feedbacks:', err);
    } finally {
      if (isInitial) setLoading(false);
    }
  };

  useEffect(() => {
    fetchFeedbacks(true);

    const unsub = subscribeToFeedbacks((liveList) => {
      if (liveList && liveList.length > 0) {
        setFeedbacks(liveList);
        calculateStats(liveList);
        setLoading(false);
      }
    });

    const interval = setInterval(() => {
      fetchFeedbacks(false);
    }, 6000);

    return () => {
      clearInterval(interval);
      if (typeof unsub === 'function') unsub();
    };
  }, []);

  const displayedFeedbacks = filterRating === 'all'
    ? feedbacks
    : feedbacks.filter((f) => Math.round(f.rating) === filterRating);

  return (
    <div className="space-y-4">
      {/* Header & Rating Overview */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Rating Score Card */}
        <div className="bg-white p-5 rounded-2xl border border-stone-200 shadow-xs flex flex-col justify-between">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-stone-500 uppercase tracking-wider">
              Customer Satisfaction
            </span>
            <Award className="w-5 h-5 text-amber-500" />
          </div>

          <div className="my-3 flex items-baseline gap-3">
            <span className="text-4xl font-black text-stone-900">{averageRating.toFixed(1)}</span>
            <div className="flex items-center gap-0.5 text-amber-500">
              {[1, 2, 3, 4, 5].map((star) => (
                <Star
                  key={star}
                  className={`w-5 h-5 ${
                    star <= Math.round(averageRating) ? 'fill-amber-400 text-amber-500' : 'text-stone-300'
                  }`}
                />
              ))}
            </div>
          </div>

          <p className="text-xs font-medium text-stone-500">
            Based on <strong className="text-stone-800">{totalCount} ratings</strong> from dine-in guests
          </p>
        </div>

        {/* Breakdown Card */}
        <div className="bg-white p-5 rounded-2xl border border-stone-200 shadow-xs md:col-span-2 flex flex-col justify-between">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold text-stone-500 uppercase tracking-wider">
              Rating Breakdown
            </span>
            <button
              onClick={() => fetchFeedbacks(true)}
              className="p-1.5 bg-stone-100 hover:bg-stone-200 text-stone-700 rounded-lg transition-colors"
              title="Refresh Feedback"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>

          <div className="space-y-1.5">
            {[5, 4, 3, 2, 1].map((r) => {
              const count = distribution[r] || 0;
              const percent = totalCount > 0 ? (count / totalCount) * 100 : 0;
              return (
                <div key={r} className="flex items-center gap-2 text-xs">
                  <span className="w-12 font-bold text-stone-700 flex items-center gap-1">
                    <span>{r}</span>
                    <Star className="w-3 h-3 fill-amber-400 text-amber-500" />
                  </span>
                  <div className="flex-1 bg-stone-100 rounded-full h-2 overflow-hidden">
                    <div
                      className="bg-amber-500 h-full rounded-full transition-all duration-500"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                  <span className="w-8 text-right font-semibold text-stone-500">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="bg-white p-3 rounded-2xl border border-stone-200 shadow-xs flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-1.5 overflow-x-auto">
          <button
            onClick={() => setFilterRating('all')}
            className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all ${
              filterRating === 'all'
                ? 'bg-stone-900 text-white shadow-xs'
                : 'bg-stone-100 text-stone-700 hover:bg-stone-200'
            }`}
          >
            All Reviews ({feedbacks.length})
          </button>
          {[5, 4, 3, 2, 1].map((r) => (
            <button
              key={r}
              onClick={() => setFilterRating(r)}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-1 ${
                filterRating === r
                  ? 'bg-amber-600 text-white shadow-xs'
                  : 'bg-stone-100 text-stone-700 hover:bg-stone-200'
              }`}
            >
              <span>{r}</span>
              <Star className={`w-3 h-3 ${filterRating === r ? 'fill-white text-white' : 'fill-amber-400 text-amber-500'}`} />
              <span>({distribution[r] || 0})</span>
            </button>
          ))}
        </div>
      </div>

      {/* Feedback List */}
      {displayedFeedbacks.length === 0 ? (
        <div className="bg-white rounded-3xl p-12 text-center border border-stone-200 space-y-2">
          <div className="w-12 h-12 rounded-full bg-amber-50 text-amber-600 flex items-center justify-center mx-auto">
            <MessageSquare className="w-6 h-6" />
          </div>
          <h3 className="font-bold text-stone-800 text-sm">No Feedbacks in this Category</h3>
          <p className="text-xs text-stone-500 max-w-sm mx-auto">
            Customer reviews submitted on the order confirmation screen will appear here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {displayedFeedbacks.map((fb) => (
            <div
              key={fb.id}
              className="bg-white p-5 rounded-2xl border border-stone-200 shadow-xs flex flex-col justify-between space-y-3"
            >
              <div>
                {/* Header: Stars & Table */}
                <div className="flex items-center justify-between gap-2 mb-2">
                  <div className="flex items-center gap-0.5 text-amber-500">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <Star
                        key={star}
                        className={`w-4 h-4 ${
                          star <= fb.rating ? 'fill-amber-400 text-amber-500' : 'text-stone-200'
                        }`}
                      />
                    ))}
                  </div>

                  <span className="px-2.5 py-0.5 rounded-lg bg-orange-100 text-orange-900 font-bold text-xs">
                    Table {fb.tableNumber}
                  </span>
                </div>

                {/* Comment */}
                {fb.comment ? (
                  <p className="text-xs text-stone-800 font-medium leading-relaxed italic bg-stone-50 p-3 rounded-xl border border-stone-150 mb-3">
                    "{fb.comment}"
                  </p>
                ) : (
                  <p className="text-xs text-stone-400 font-normal italic bg-stone-50/50 p-2.5 rounded-xl border border-stone-100 mb-3">
                    Rated without written comments
                  </p>
                )}
              </div>

              {/* Footer Details */}
              <div className="pt-2 border-t border-stone-100 flex items-center justify-between text-[11px] text-stone-500">
                <span className="font-bold text-stone-800 flex items-center gap-1">
                  <User className="w-3 h-3 text-stone-400" />
                  <span>{fb.customerName}</span>
                </span>
                <span>{new Date(fb.createdAt).toLocaleDateString()}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
