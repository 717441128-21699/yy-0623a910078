export interface Product {
  id: number;
  brand: string;
  name: string;
  specification: string;
  unit: string;
  stock: number;
  price: number;
  category?: string;
  created_at: string;
  updated_at: string;
}

export interface Clinic {
  id: number;
  name: string;
  contact_person?: string;
  phone?: string;
  address?: string;
  created_at: string;
}

export type OrderSource = 'wechat' | 'phone' | 'miniprogram';
export type OrderStatus = 'draft' | 'confirmed' | 'stockout_handling' | 'ready_to_ship' | 'shipped' | 'completed' | 'cancelled';
export type OrderUrgency = 'emergency' | 'normal' | 'routine';
export type StockStatus = 'available' | 'out_of_stock' | 'low_stock';

export interface Order {
  id: number;
  order_no: string;
  clinic_id: number;
  source: OrderSource;
  raw_content?: string;
  status: OrderStatus;
  urgency: OrderUrgency;
  urgency_note?: string;
  total_amount: number;
  created_by?: string;
  created_at: string;
  updated_at: string;
}

export interface OrderItem {
  id: number;
  order_id: number;
  product_id?: number;
  product_name: string;
  specification: string;
  brand?: string;
  quantity: number;
  unit_price: number;
  subtotal: number;
  stock_status: StockStatus;
  note?: string;
}

export type StockoutPlanType = 'alternative' | 'restock' | 'split';

export interface StockoutPlan {
  id: number;
  order_item_id: number;
  plan_type: StockoutPlanType;
  alternative_brand?: string;
  alternative_spec?: string;
  alternative_product_id?: number;
  restock_date?: string;
  split_shipment?: number;
  created_at: string;
}

export interface DeliveryHandover {
  id: number;
  order_id: number;
  warehouse_note?: string;
  driver_note?: string;
  pack_status: string;
  delivery_status: string;
  package_count: number;
  handed_by?: string;
  handed_at?: string;
  received_by?: string;
  received_at?: string;
  created_at: string;
}

export interface OrderWithItems extends Order {
  items: OrderItem[];
  clinic?: Clinic;
  delivery?: DeliveryHandover;
}

export interface ParseResultItem {
  product_name: string;
  specification: string;
  quantity: number;
  raw_text: string;
  similarProducts?: Product[];
}

export interface ParseResult {
  items: ParseResultItem[];
  warnings: string[];
}
