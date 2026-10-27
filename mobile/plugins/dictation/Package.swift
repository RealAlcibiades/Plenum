// swift-tools-version: 5.9
// Swift Package for the Plenum dictation plugin (mob-13). Capacitor 8 links plugins with Swift Package Manager; the
// iOS project (mobile/ios, mob-14) adds this package through mobile/package.json. Deployment target iOS 16.
// The package and its library product are named PlenumDictation: the Capacitor CLI takes the name from the npm package
// (plenum-dictation -> PlenumDictation) and writes it into CapApp-SPM/Package.swift. The target keeps its name.
import PackageDescription

let package = Package(
    name: "PlenumDictation",
    platforms: [.iOS(.v16)],
    products: [
        .library(
            name: "PlenumDictation",
            targets: ["DictationPlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")
    ],
    targets: [
        .target(
            name: "DictationPlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm")
            ],
            path: "ios/Sources/DictationPlugin")
    ]
)
