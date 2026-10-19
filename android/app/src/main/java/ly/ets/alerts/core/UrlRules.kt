package ly.ets.alerts.core

import java.net.URI
import java.net.URISyntaxException
import java.util.Locale

object UrlRules {
    /**
     * Validates a server base URL: https only, has a host, no credentials, query or fragment.
     * Returns it without a trailing slash, e.g. `https://ets.example.local` or `https://10.0.0.5:8443/ets`.
     * Throws [IllegalArgumentException] otherwise.
     */
    fun normalizeBaseUrl(raw: String): String {
        val text = raw.trim()
        val uri = try {
            URI(text)
        } catch (e: URISyntaxException) {
            throw IllegalArgumentException("invalid url")
        }
        require(uri.scheme?.lowercase(Locale.ROOT) == "https") { "https required" }
        val host = uri.host
        require(!host.isNullOrEmpty()) { "missing host" }
        require(uri.rawUserInfo == null) { "credentials not allowed" }
        require(uri.rawQuery == null && uri.rawFragment == null) { "query/fragment not allowed" }
        val port = uri.port
        require(port == -1 || port in 1..65535) { "bad port" }
        val path = (uri.rawPath ?: "").trimEnd('/')
        val hostPart = if (host.contains(':') && !host.startsWith("[")) "[$host]" else host
        val portPart = if (port == -1 || port == 443) "" else ":$port"
        return "https://${hostPart.lowercase(Locale.ROOT)}$portPart$path"
    }

    /** Joins the base URL with an API path that starts with '/'. */
    fun api(baseUrl: String, path: String): String {
        require(path.startsWith("/")) { "path must start with /" }
        return baseUrl + path
    }

    /**
     * Turns a notification `link` (a path like `/app/123`) into a browser URL on the paired server.
     * Anything that is not a plain same-origin path (absolute URLs, `//host`, backslashes,
     * control characters) falls back to the server root so a link can never leave the server.
     */
    fun resolveLink(baseUrl: String, link: String?): String {
        val root = "$baseUrl/"
        val l = link?.trim() ?: return root
        if (!l.startsWith("/") || l.startsWith("//") || l.contains('\\')) return root
        if (l.any { it.isWhitespace() || it.code < 0x20 || it.code == 0x7f }) return root
        val candidate = baseUrl + l
        return try {
            val b = URI(baseUrl)
            val c = URI(candidate)
            if (c.scheme == "https" && c.host == b.host && c.port == b.port) candidate else root
        } catch (e: URISyntaxException) {
            root
        }
    }

    /** Host part of a normalized base URL, for display. */
    fun displayHost(baseUrl: String): String = try {
        URI(baseUrl).host ?: baseUrl
    } catch (e: URISyntaxException) {
        baseUrl
    }
}
