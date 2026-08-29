export type OrderStatus = 'new' | 'accepted' | 'ready' | 'completed' | 'cancelled';
export type PaymentStatus = 'unpaid' | 'paid' | 'refunded';

export interface ProductVariant {
  id: string;
  name: string; // e.g. "Half", "Full", "Regular", "Large"
  price: number;
}

export interface Product {
  id: string;
  name: string;
  description: string;
  category: string;
  image: string;
  isAvailable: boolean;
  isVeg?: boolean; // true = Veg 🟢, false = Non-Veg 🔴
  hasVariants: boolean;
  basePrice?: number; // Used if hasVariants is false
  variants?: ProductVariant[]; // Used if hasVariants is true
  displayOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerFeedback {
  id: string;
  orderId?: string;
  orderNumber?: string;
  tableNumber: number;
  tableName: string;
  customerName: string;
  rating: number; // 1 to 5 stars
  comment: string;
  createdAt: string;
}

export interface WaiterCall {
  id: string;
  tableId?: string;
  tableNumber: number;
  tableName: string;
  customerName?: string;
  status: 'pending' | 'attended';
  createdAt?: string;
  calledAt?: string;
  attendedAt?: string;
}

export interface CafeTable {
  id: string;
  tableNumber: number;
  name: string; // e.g. "Table 1", "Outdoor 2", etc.
  token: string; // Permanent unguessable token
  isActive: boolean;
  createdAt: string;
}

export interface CartItem {
  productId: string;
  productName: string;
  variantId?: string;
  variantName?: string;
  price: number;
  quantity: number;
  image: string;
}

export interface OrderItem {
  id: string;
  productId: string;
  productName: string;
  variantId?: string;
  variantName?: string;
  unitPrice: number; // Historical price snapshotted at order time
  quantity: number;
  totalPrice: number;
}

export interface OrderTimeline {
  createdAt: string;
  acceptedAt?: string;
  readyAt?: string;
  completedAt?: string;
  cancelledAt?: string;
}

export interface Order {
  id: string;
  orderNumber: string; // e.g. "NT-1042"
  tableId: string;
  tableNumber: number;
  tableName: string;
  customerName: string;
  customerPhone?: string;
  specialInstructions?: string;
  items: OrderItem[];
  subtotal: number;
  tax: number;
  totalAmount: number;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  timeline: OrderTimeline;
  cancellationReason?: string;
  whatsappNotificationSent: boolean;
  whatsappNotificationError?: string;
}

export interface CafeCategory {
  id: string;
  name: string;
  icon?: string;
  displayOrder: number;
}

export interface CafeSettings {
  cafeName: string;
  tagline: string;
  address: string;
  phone: string;
  whatsappNumber: string;
  currency: string;
  upiId?: string;
  enableWhatsAppAlerts: boolean;
  whatsappApiUrl?: string;
  whatsappApiToken?: string;
  enableSoundAlerts: boolean;
}

export interface SalesSummary {
  totalRevenue: number;
  totalOrders: number;
  completedOrders: number;
  cancelledOrders: number;
  pendingOrders: number;
  averageOrderValue: number;
  paidAmount: number;
  unpaidAmount: number;
  topSellingItems: {
    name: string;
    variant?: string;
    quantity: number;
    revenue: number;
  }[];
  recentOrders: Order[];
}

