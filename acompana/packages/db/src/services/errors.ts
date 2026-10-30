/** Error con código estable que las apps traducen a HTTP. */
export class HttpErrorLike extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
