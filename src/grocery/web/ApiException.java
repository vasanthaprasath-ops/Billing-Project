package grocery.web;

/** A request error that should be reported with a specific HTTP status code (401, 403, 404, ...). */
public class ApiException extends RuntimeException {

    public final int status;

    public ApiException(int status, String message) {
        super(message);
        this.status = status;
    }

    public static ApiException notSignedIn() {
        return new ApiException(401, "Not signed in.");
    }

    public static ApiException forbidden(String message) {
        return new ApiException(403, message);
    }

    public static ApiException notFound(String message) {
        return new ApiException(404, message);
    }
}
