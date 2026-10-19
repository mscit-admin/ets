plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

// Version and signing come from the environment (set by .github/workflows/android.yml).
// Local builds fall back to 1 / 1.0.0 and an unsigned release.
fun env(name: String): String? = providers.environmentVariable(name).orNull?.takeIf { it.isNotBlank() }

val etsVersionCode = env("ETS_VERSION_CODE")?.toIntOrNull() ?: 1
val etsVersionName = env("ETS_VERSION_NAME") ?: "1.0.0"

val keystorePath = env("ANDROID_KEYSTORE_PATH")
val hasReleaseSigning = keystorePath != null &&
    env("ANDROID_KEYSTORE_PASSWORD") != null &&
    env("ANDROID_KEY_ALIAS") != null &&
    env("ANDROID_KEY_PASSWORD") != null

android {
    namespace = "ly.ets.alerts"
    compileSdk = 34

    defaultConfig {
        applicationId = "ly.ets.alerts"
        minSdk = 26
        targetSdk = 34
        versionCode = etsVersionCode
        versionName = etsVersionName
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(keystorePath!!)
                storePassword = env("ANDROID_KEYSTORE_PASSWORD")
                keyAlias = env("ANDROID_KEY_ALIAS")
                keyPassword = env("ANDROID_KEY_PASSWORD")
                enableV1Signing = false
                enableV2Signing = true
                enableV3Signing = true
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        buildConfig = true
    }

    lint {
        // Lint reports are uploaded by CI; they never fail the build.
        abortOnError = false
        checkReleaseBuilds = false
    }

    packaging {
        resources {
            excludes += "/META-INF/{AL2.0,LGPL2.1}"
        }
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.work.runtime.ktx)
    implementation(libs.okhttp.core)
    implementation(libs.okhttp.sse)
    implementation(libs.zxing.android.embedded)

    testImplementation(libs.junit)
    testImplementation(libs.org.json)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.okhttp.tls)
}
