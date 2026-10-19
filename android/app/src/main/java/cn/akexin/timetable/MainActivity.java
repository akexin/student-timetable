package cn.akexin.timetable;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.KeyEvent;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * 学生课表系统 —— 离线外壳。
 *
 * 页面通过 WebViewAssetLoader 挂在 https://appassets.androidplatform.net 下，
 * 属于安全来源（secure origin），因此 localStorage / IndexedDB 均可正常工作，
 * 这也是离线数据能持久化的前提。
 *
 * 前端资源来自 assets/（由 Gradle 从仓库根的 public/ 同步而来）。
 */
public class MainActivity extends Activity {

    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + APP_HOST + "/index.html";

    private WebView webView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView = new WebView(this);
        setContentView(webView);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);      // localStorage / IndexedDB
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);        // 一切资源走 assetLoader
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMediaPlaybackRequiresUserGesture(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // 站内路由自行处理，站外链接不在本 App 内打开
                return !APP_HOST.equals(request.getUrl().getHost());
            }
        });

        // 导出 CSV / XLSX / ICS 时的保存通道（WebView 对 blob: 下载支持有限）
        webView.addJavascriptInterface(new FileBridge(), "AndroidSaver");

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(START_URL);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView != null && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("AndroidSaver");
            webView.destroy();
        }
        super.onDestroy();
    }

    /** 供前端 downloadBlob 调用的原生保存通道 */
    private class FileBridge {

        @JavascriptInterface
        public void saveBase64(String base64, String filename, String mime) {
            final String message;
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                String target = writeToDownloads(bytes, filename, mime);
                message = "已保存到 " + target;
            } catch (Exception e) {
                final String err = e.getMessage() == null ? e.toString() : e.getMessage();
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Toast.makeText(MainActivity.this, "保存失败：" + err, Toast.LENGTH_LONG).show();
                    }
                });
                return;
            }
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(MainActivity.this, message, Toast.LENGTH_LONG).show();
                }
            });
        }
    }

    /** Android 10+ 写入公共「下载」目录（无需存储权限）；更低版本落到应用专属目录 */
    private String writeToDownloads(byte[] bytes, String filename, String mime) throws Exception {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, filename);
            values.put(MediaStore.Downloads.MIME_TYPE, mime);
            values.put(MediaStore.Downloads.IS_PENDING, 1);

            Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new Exception("系统未返回下载项地址");

            OutputStream os = getContentResolver().openOutputStream(uri);
            if (os == null) throw new Exception("无法打开输出流");
            try {
                os.write(bytes);
                os.flush();
            } finally {
                os.close();
            }

            values.clear();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            getContentResolver().update(uri, values, null, null);
            return "下载/" + filename;
        }

        File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) dir = getFilesDir();
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("无法创建目录");

        File out = new File(dir, filename);
        FileOutputStream fos = new FileOutputStream(out);
        try {
            fos.write(bytes);
            fos.flush();
        } finally {
            fos.close();
        }
        return out.getAbsolutePath();
    }
}
