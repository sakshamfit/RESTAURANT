import {
  CafeCategory,
  CafeSettings,
  CafeTable,
  CustomerFeedback,
  Order,
  Product,
  WaiterCall,
} from '../types';

const createdAt = '2026-01-01T00:00:00.000Z';

export const initialSettings: CafeSettings = {
  cafeName: 'Nagori Chai Point',
  tagline: 'Authentic Chai, Fresh Snacks & Quick Bites',
  address: 'Near City Center, Main Road',
  phone: '+91 9852120609',
  whatsappNumber: '9852120609',
  currency: '₹',
  upiId: '9852120609@upi',
  enableWhatsAppAlerts: true,
  whatsappApiUrl: '',
  whatsappApiToken: '',
  enableSoundAlerts: true,
};

export const initialCategories: CafeCategory[] = [
  { id: 'cat-tea-coffee', name: 'Tea & Coffee', displayOrder: 1 },
  { id: 'cat-cold-drinks', name: 'Cold Drinks & Water', displayOrder: 2 },
  { id: 'cat-snacks', name: 'Snacks', displayOrder: 3 },
  { id: 'cat-burgers', name: 'Burgers', displayOrder: 4 },
  { id: 'cat-momos', name: 'Momos', displayOrder: 5 },
  { id: 'cat-chinese', name: 'Chinese', displayOrder: 6 },
];

export const initialTables: CafeTable[] = Array.from({ length: 6 }, (_, index) => {
  const tableNumber = index + 1;
  const suffixes = ['9a2f7c', '4b8e1d', '7c3a9f', '1f5e8b', '3d6a2c', '8e0b4f'];
  return {
    id: `tbl-${tableNumber}`,
    tableNumber,
    name: `Table ${tableNumber}`,
    token: `nagori_tbl_tok_table${tableNumber}_${suffixes[index]}`,
    isActive: true,
    createdAt,
  };
});

export const initialProducts: Product[] = [
  {
    id: 'prod-tea',
    name: 'Special Masala Chai',
    description: 'Nagori special kadak masala chai prepared with whole spices, fresh ginger, cardamom, and creamy milk.',
    category: 'Tea & Coffee',
    image: '',
    isAvailable: true,
    isVeg: true,
    hasVariants: false,
    basePrice: 10,
    displayOrder: 1,
    createdAt,
    updatedAt: createdAt,
  },
  {
    id: 'prod-coffee',
    name: 'Hot Filter Coffee',
    description: 'Aromatic freshly brewed hot filter coffee whipped to frothy perfection with rich milk.',
    category: 'Tea & Coffee',
    image: '',
    isAvailable: true,
    isVeg: true,
    hasVariants: false,
    basePrice: 30,
    displayOrder: 2,
    createdAt,
    updatedAt: createdAt,
  },
  {
    id: 'prod-cold-drink',
    name: 'Cold Drink (Chilled 250ml)',
    description: 'Chilled refreshing cold drink can/bottle (Thums Up, Coca Cola, Sprite, Maaza).',
    category: 'Cold Drinks & Water',
    image: '',
    isAvailable: true,
    isVeg: true,
    hasVariants: false,
    basePrice: 20,
    displayOrder: 3,
    createdAt,
    updatedAt: createdAt,
  },
  {
    id: 'prod-water-bottle',
    name: 'Packaged Drinking Water',
    description: 'Pure and sealed mineral drinking water bottle chilled to perfection.',
    category: 'Cold Drinks & Water',
    image: '',
    isAvailable: true,
    isVeg: true,
    hasVariants: true,
    variants: [
      { id: 'var-water-500ml', name: '500ml Bottle', price: 10 },
      { id: 'var-water-1ltr', name: '1 Litre Bottle', price: 20 },
    ],
    displayOrder: 4,
    createdAt,
    updatedAt: createdAt,
  },
  {
    id: 'prod-samosa',
    name: 'Crispy Samosa',
    description: 'Crispy, golden-fried pastry stuffed with spiced potatoes and peas. Served with tangy mint and sweet tamarind chutneys.',
    category: 'Snacks',
    image: '',
    isAvailable: true,
    isVeg: true,
    hasVariants: false,
    basePrice: 10,
    displayOrder: 5,
    createdAt,
    updatedAt: createdAt,
  },
  {
    id: 'prod-burger',
    name: 'Veg Aloo Tikki Burger',
    description: 'Crispy spiced vegetable aloo tikki in a toasted sesame bun with sliced onions, crunchy cabbage, and house sauces.',
    category: 'Burgers',
    image: '',
    isAvailable: true,
    isVeg: true,
    hasVariants: false,
    basePrice: 50,
    displayOrder: 6,
    createdAt,
    updatedAt: createdAt,
  },
  {
    id: 'prod-momos-veg',
    name: 'Veg Steamed Momos',
    description: 'Authentic Himalayan dumplings stuffed with freshly seasoned cabbage, carrots, paneer, and herbs. Served with fiery spicy red chili chutney.',
    category: 'Momos',
    image: '',
    isAvailable: true,
    isVeg: true,
    hasVariants: true,
    variants: [
      { id: 'var-veg-momos-half', name: 'Half (5 Pcs)', price: 50 },
      { id: 'var-veg-momos-full', name: 'Full (10 Pcs)', price: 90 },
    ],
    displayOrder: 7,
    createdAt,
    updatedAt: createdAt,
  },
  {
    id: 'prod-momos-nonveg',
    name: 'Non-Veg Chicken Momos',
    description: 'Juicy minced chicken infused with ginger, garlic, and special spices inside delicate steamed dumpling wrappers. Served with hot momo dip.',
    category: 'Momos',
    image: '',
    isAvailable: true,
    isVeg: false,
    hasVariants: true,
    variants: [
      { id: 'var-nv-momos-half', name: 'Half (5 Pcs)', price: 70 },
      { id: 'var-nv-momos-full', name: 'Full (10 Pcs)', price: 130 },
    ],
    displayOrder: 8,
    createdAt,
    updatedAt: createdAt,
  },
  {
    id: 'prod-chowmein',
    name: 'Veg Chow Mein',
    description: 'Street-style wok-tossed noodles loaded with crunchy julienned bell peppers, shredded cabbage, carrots, and savory sauces.',
    category: 'Chinese',
    image: '',
    isAvailable: true,
    isVeg: true,
    hasVariants: true,
    variants: [
      { id: 'var-chowmein-half', name: 'Half Plate', price: 80 },
      { id: 'var-chowmein-full', name: 'Full Plate', price: 150 },
    ],
    displayOrder: 9,
    createdAt,
    updatedAt: createdAt,
  },
];

export interface AppSnapshot {
  settings: CafeSettings;
  categories: CafeCategory[];
  tables: CafeTable[];
  products: Product[];
  orders: Order[];
  feedbacks: CustomerFeedback[];
  waiterCalls: WaiterCall[];
}

export function createMemorySnapshot(): AppSnapshot {
  return {
    settings: structuredClone(initialSettings),
    categories: structuredClone(initialCategories),
    tables: structuredClone(initialTables),
    products: structuredClone(initialProducts),
    orders: [],
    feedbacks: [],
    waiterCalls: [],
  };
}
