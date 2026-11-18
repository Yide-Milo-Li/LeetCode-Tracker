/** A coded failure with a message the MCP client can show to the user. */
export class ProfileError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'ProfileError';
  }
}
