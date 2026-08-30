export class InvalidRawInputError extends Error {
  constructor() {
    super("Raw follow-up input must contain between 1 and 10000 characters.");
    this.name = "InvalidRawInputError";
  }
}
