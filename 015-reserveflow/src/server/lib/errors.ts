export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = 'データ') => new AppError(404, 'NOT_FOUND', `${what}が見つかりません`);
export const forbidden = (msg = 'この操作の権限がありません') => new AppError(403, 'FORBIDDEN', msg);
export const badRequest = (msg: string, details?: unknown) => new AppError(400, 'BAD_REQUEST', msg, details);
export const conflict = (code: string, msg: string, details?: unknown) => new AppError(409, code, msg, details);
