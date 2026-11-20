/**
 * An error returned to the client as `{ "error": code, "message": message }`.
 * Codes match the apps' `PartnerError` cases where one exists, so the apps can map them directly.
 */
export class ApiError extends Error {
    readonly status: number;
    readonly code: string;

    constructor(status: number, code: string, message: string) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

export const unauthorized = () => new ApiError(401, "unauthorized", "Sign in again.");
export const businessNotFound = () => new ApiError(404, "businessNotFound", "Set up your business first.");
export const programNotFound = () => new ApiError(404, "programNotFound", "Publish your card first.");
export const invalid = (code: string, message: string) => new ApiError(400, code, message);
export const placeNotFound = () => new ApiError(404, "placeNotFound", "This place isn't on JOEYY.");
