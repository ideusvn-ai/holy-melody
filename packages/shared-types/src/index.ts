/** DTO dùng chung desktop ↔ backend (khớp với backend/src/App.php) */
export interface ApiError { error: { code: string; message: string; details?: Record<string, unknown> } }
export interface MeResponse { user: { id: number; email: string | null; name: string | null; avatar_url: string | null }; balance: number }
export interface CreditPackage { id: number; code: string; name: string; credits: number; price_vnd: number }
export interface PaymentOrder { id: number; status: 'pending' | 'paid' | 'failed' | 'cancelled' | 'expired' | 'refunded'; gateway: 'payos' | 'vnpay' | 'momo'; amount_vnd: number; credits: number; checkout_url: string | null }
export interface AiJob { id: number; type: 'harmony' | 'singer' | 'lyrics' | 'other'; status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled'; credit_cost: number; progress: number | null; error: { code: string; message: string } | null }
