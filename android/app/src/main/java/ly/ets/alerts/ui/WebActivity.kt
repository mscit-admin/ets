package ly.ets.alerts.ui

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslCertificate
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.ProgressBar
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import ly.ets.alerts.BuildConfig
import ly.ets.alerts.R
import ly.ets.alerts.Session
import ly.ets.alerts.core.WebRules
import ly.ets.alerts.data.Settings

/**
 * Main screen (1.1.0): the ETS web application of the paired server in a WebView — the same pages as in the
 * browser, signed in with the user's own password and 2FA. Its User-Agent carries "ETSAlerts/<version> (Android)",
 * so the server makes the session read-only (view only; changes are made in a browser).
 *
 * Security: only the paired origin loads here (anything else opens in the external browser); no file or content
 * access, no JavaScript interface; a TLS error is overridden ONLY for the pinned certificate on the paired host
 * ([WebRules.allowCertificate]); without a pin the system trust decides.
 */
class WebActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var progress: ProgressBar
    private lateinit var errorBox: View
    private lateinit var errorText: TextView
    private var baseUrl: String = ""
    private var pin: String? = null
    private var mainFrameFailed = false

    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* nothing to do either way */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val settings = Settings.get(this)
        val base = settings.baseUrl
        if (!settings.isPaired || base == null) {
            startActivity(Intent(this, DeviceActivity::class.java))
            finish()
            return
        }
        baseUrl = base
        pin = settings.certSha256
        setContentView(R.layout.activity_web)
        web = findViewById(R.id.web)
        progress = findViewById(R.id.web_progress)
        errorBox = findViewById(R.id.web_error)
        errorText = findViewById(R.id.web_error_text)
        findViewById<Button>(R.id.web_retry).setOnClickListener { retry() }
        configure(web)

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (web.canGoBack()) web.goBack() else finish()
            }
        })

        askNotificationPermission()
        Session.ensureRunning(this)

        val restored = savedInstanceState != null && web.restoreState(savedInstanceState) != null
        if (!restored) web.loadUrl(targetOf(intent) ?: home())
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (!::web.isInitialized) return
        targetOf(intent)?.let { web.loadUrl(it) }
    }

    override fun onResume() {
        super.onResume()
        if (!::web.isInitialized) return
        // unpaired or paired again with another server meanwhile: start over
        val settings = Settings.get(this)
        if (!settings.isPaired || settings.baseUrl != baseUrl || settings.certSha256 != pin) {
            startActivity(Intent(this, if (settings.isPaired) WebActivity::class.java else DeviceActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_NEW_TASK))
            finish()
            return
        }
        web.onResume()
    }

    override fun onPause() {
        if (::web.isInitialized) {
            web.onPause()
            CookieManager.getInstance().flush()
        }
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        if (::web.isInitialized) web.saveState(outState)
    }

    override fun onDestroy() {
        if (::web.isInitialized) {
            (web.parent as? ViewGroup)?.removeView(web)
            web.destroy()
        }
        super.onDestroy()
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menuInflater.inflate(R.menu.menu_web, menu)
        return true
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean = when (item.itemId) {
        R.id.action_refresh -> {
            retry()
            true
        }
        R.id.action_home -> {
            hideError()
            web.loadUrl(home())
            true
        }
        R.id.action_alerts -> {
            startActivity(Intent(this, MainActivity::class.java))
            true
        }
        R.id.action_device -> {
            startActivity(Intent(this, DeviceActivity::class.java))
            true
        }
        else -> super.onOptionsItemSelected(item)
    }

    private fun home() = "$baseUrl/"

    /** The page a notification tap asked for, when it is on the paired server. */
    private fun targetOf(intent: Intent?): String? =
        intent?.getStringExtra(EXTRA_URL)?.takeIf { WebRules.isInApp(baseUrl, it) }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configure(view: WebView) {
        with(view.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            @Suppress("DEPRECATION")
            allowFileAccessFromFileURLs = false
            @Suppress("DEPRECATION")
            allowUniversalAccessFromFileURLs = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setGeolocationEnabled(false)
            userAgentString = WebRules.userAgent(userAgentString, BuildConfig.VERSION_NAME)
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        view.webViewClient = Client()
        view.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(v: WebView, newProgress: Int) {
                progress.progress = newProgress
                progress.visibility = if (newProgress in 0..99) View.VISIBLE else View.GONE
            }
        }
        // Excel exports are made in the page (a blob download), which the WebView cannot save: say so.
        view.setDownloadListener { _, _, _, _, _ ->
            Toast.makeText(this, R.string.web_download_unsupported, Toast.LENGTH_LONG).show()
        }
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url?.toString() ?: return true
            if (WebRules.isInApp(baseUrl, url)) return false
            openExternal(request.url)
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            mainFrameFailed = false
            progress.visibility = View.VISIBLE
        }

        override fun onPageFinished(view: WebView, url: String?) {
            progress.visibility = View.GONE
            if (mainFrameFailed) return
            // a pinned pairing also checks a certificate the system trusts (no TLS error was reported)
            if (WebRules.isInApp(baseUrl, url) && !WebRules.pageCertificateOk(pin, leafDer(view.certificate))) {
                view.stopLoading()
                view.loadUrl("about:blank")
                showError(getString(R.string.web_error_tls))
                return
            }
            hideError()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            mainFrameFailed = true
            showError(getString(R.string.web_error_body))
        }

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            if (WebRules.allowCertificate(pin, baseUrl, error.url, leafDer(error.certificate))) {
                handler.proceed()
                return
            }
            handler.cancel()
            mainFrameFailed = true
            showError(getString(R.string.web_error_tls))
        }
    }

    private fun openExternal(uri: Uri?) {
        val scheme = uri?.scheme?.lowercase() ?: return
        if (scheme != "https" && scheme != "http" && scheme != "mailto") return
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (e: ActivityNotFoundException) {
            Toast.makeText(this, R.string.no_browser, Toast.LENGTH_LONG).show()
        }
    }

    private fun retry() {
        hideError()
        val current = web.url
        if (current != null && WebRules.isInApp(baseUrl, current)) web.reload() else web.loadUrl(home())
    }

    private fun showError(message: String) {
        errorText.text = message
        errorBox.visibility = View.VISIBLE
        progress.visibility = View.GONE
    }

    private fun hideError() {
        errorBox.visibility = View.GONE
    }

    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    companion object {
        const val EXTRA_URL = "url"

        /** DER encoding of the leaf certificate: getX509Certificate() on API 29+, the saved state before. */
        fun leafDer(cert: SslCertificate?): ByteArray? {
            if (cert == null) return null
            return try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    cert.x509Certificate?.encoded
                } else {
                    SslCertificate.saveState(cert)?.getByteArray("x509-certificate")
                }
            } catch (e: Exception) {
                null
            }
        }

        /** Opens [url] (already checked to be on the paired server) in the app's WebView. */
        fun open(context: Context, url: String) {
            context.startActivity(
                Intent(context, WebActivity::class.java)
                    .putExtra(EXTRA_URL, url)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            )
        }
    }
}
