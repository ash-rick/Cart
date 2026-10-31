/**
 * Error catalog: the single place where an error code is mapped to its HTTP status.
 * 409 = the request is valid but conflicts with current state (retrying later or with a
 *       different payload may succeed); 422 = the request refers to something that does
 *       not exist or cannot be processed as given.
 */
export const ERROR_STATUS = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  CART_NOT_FOUND: 404,
  ORDER_NOT_FOUND: 404,
  PRODUCT_NOT_FOUND: 422,
  CART_EMPTY: 422,
  COUPON_NOT_FOUND: 422,
  CART_ALREADY_CHECKED_OUT: 409,
  INSUFFICIENT_INVENTORY: 409,
  PRICE_CHANGED: 409,
  COUPON_ALREADY_REDEEMED: 409,
  NO_ELIGIBLE_MILESTONE: 409,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;
export type ErrorDetails = Record<string, unknown>;

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly httpStatus: number,
    message: string,
    readonly details?: ErrorDetails,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

function make(code: ErrorCode, message: string, details?: ErrorDetails): AppError {
  return new AppError(code, ERROR_STATUS[code], message, details);
}

export interface Shortfall {
  productId: string;
  requested: number;
  available: number;
}

export const errors = {
  validation: (message: string, details?: ErrorDetails) => make('VALIDATION_ERROR', message, details),
  routeNotFound: (method: string, url: string) =>
    make('NOT_FOUND', `Route ${method} ${url} not found`),
  cartNotFound: (cartId: string) => make('CART_NOT_FOUND', 'Cart not found', { cartId }),
  orderNotFound: (orderId: string) => make('ORDER_NOT_FOUND', 'Order not found', { orderId }),
  productNotFound: (productId: string) =>
    make('PRODUCT_NOT_FOUND', 'Product not found', { productId }),
  cartEmpty: (cartId: string) => make('CART_EMPTY', 'Cannot check out an empty cart', { cartId }),
  couponNotFound: (couponCode: string) =>
    make('COUPON_NOT_FOUND', 'Coupon code not found', { couponCode }),
  cartAlreadyCheckedOut: (cartId: string, details?: ErrorDetails) =>
    make('CART_ALREADY_CHECKED_OUT', 'Cart has already been checked out', { cartId, ...details }),
  insufficientInventory: (items: Shortfall[]) =>
    make('INSUFFICIENT_INVENTORY', 'Not enough stock for one or more items', { items }),
  priceChanged: (details: ErrorDetails) =>
    make('PRICE_CHANGED', 'The order total differs from expectedTotalCents', details),
  couponAlreadyRedeemed: (couponCode: string) =>
    make('COUPON_ALREADY_REDEEMED', 'Coupon has already been redeemed', { couponCode }),
  noEligibleMilestone: (details: ErrorDetails) =>
    make('NO_ELIGIBLE_MILESTONE', 'No unrewarded milestone has been reached yet', details),
};

export interface ErrorBody {
  error: { code: ErrorCode; message: string; details?: ErrorDetails };
}

export function errorBody(err: AppError): ErrorBody {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    },
  };
}
