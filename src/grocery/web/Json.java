package grocery.web;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;

/** Single shared Gson instance for the API layer. */
public final class Json {

    public static final Gson GSON = new GsonBuilder().disableHtmlEscaping().create();

    private Json() {
    }

    public static String toJson(Object o) {
        return GSON.toJson(o);
    }

    public static <T> T fromJson(String body, Class<T> type) {
        return GSON.fromJson(body, type);
    }
}
