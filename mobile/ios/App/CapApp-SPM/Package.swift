// swift-tools-version: 5.9
import PackageDescription

// DO NOT MODIFY THIS FILE - managed by Capacitor CLI commands
let package = Package(
    name: "CapApp-SPM",
    platforms: [.iOS(.v16)],
    products: [
        .library(
            name: "CapApp-SPM",
            targets: ["CapApp-SPM"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", exact: "8.5.3"),
        .package(name: "AparajitaCapacitorBiometricAuth", path: "../../../node_modules/@aparajita/capacitor-biometric-auth"),
        .package(name: "AparajitaCapacitorSecureStorage", path: "../../../node_modules/@aparajita/capacitor-secure-storage"),
        .package(name: "CapacitorApp", path: "../../../node_modules/@capacitor/app"),
        .package(name: "CapacitorBarcodeScanner", path: "../../../node_modules/@capacitor/barcode-scanner"),
        .package(name: "CapacitorBrowser", path: "../../../node_modules/@capacitor/browser"),
        .package(name: "CapacitorFilesystem", path: "../../../node_modules/@capacitor/filesystem"),
        .package(name: "CapacitorHaptics", path: "../../../node_modules/@capacitor/haptics"),
        .package(name: "CapacitorLocalNotifications", path: "../../../node_modules/@capacitor/local-notifications"),
        .package(name: "CapacitorNetwork", path: "../../../node_modules/@capacitor/network"),
        .package(name: "CapacitorShare", path: "../../../node_modules/@capacitor/share"),
        .package(name: "CapacitorTextZoom", path: "../../../node_modules/@capacitor/text-zoom"),
        .package(name: "PlenumDictation", path: "../../../node_modules/plenum-dictation")
    ],
    targets: [
        .target(
            name: "CapApp-SPM",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "AparajitaCapacitorBiometricAuth", package: "AparajitaCapacitorBiometricAuth"),
                .product(name: "AparajitaCapacitorSecureStorage", package: "AparajitaCapacitorSecureStorage"),
                .product(name: "CapacitorApp", package: "CapacitorApp"),
                .product(name: "CapacitorBarcodeScanner", package: "CapacitorBarcodeScanner"),
                .product(name: "CapacitorBrowser", package: "CapacitorBrowser"),
                .product(name: "CapacitorFilesystem", package: "CapacitorFilesystem"),
                .product(name: "CapacitorHaptics", package: "CapacitorHaptics"),
                .product(name: "CapacitorLocalNotifications", package: "CapacitorLocalNotifications"),
                .product(name: "CapacitorNetwork", package: "CapacitorNetwork"),
                .product(name: "CapacitorShare", package: "CapacitorShare"),
                .product(name: "CapacitorTextZoom", package: "CapacitorTextZoom"),
                .product(name: "PlenumDictation", package: "PlenumDictation")
            ]
        )
    ]
)
