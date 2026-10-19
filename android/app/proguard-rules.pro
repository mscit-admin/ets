# ETS Alerts R8 rules.
#
# OkHttp 4.12 and Okio ship their own consumer rules inside the jar
# (META-INF/proguard/okhttp3.pro). The lines below repeat the optional-platform
# warnings so a missing class from an alternative TLS provider never fails R8.
-dontwarn okhttp3.internal.platform.**
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

# zxing-android-embedded ships no consumer rules. CaptureActivity is kept via the
# manifest; keep the scanner package and the decoder core so that hint/format
# lookups and the result contract survive shrinking.
-keep class com.journeyapps.barcodescanner.** { *; }
-keep class com.google.zxing.** { *; }
-dontwarn com.google.zxing.**

# WorkManager instantiates workers reflectively by class name.
-keep class * extends androidx.work.ListenableWorker {
    public <init>(android.content.Context, androidx.work.WorkerParameters);
}

# Keep line numbers for readable crash traces; hide source file names.
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile
