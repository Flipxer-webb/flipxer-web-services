const path = require("node:path");
const TerserPlugin = require("terser-webpack-plugin");
const nodeExternals = require("webpack-node-externals");
const TsconfigPathsPlugin = require("tsconfig-paths-webpack-plugin");

module.exports = function createWebpackConfig(_env, argv = {}) {
    const mode = argv.mode || process.env.NODE_ENV || "development";
    const isProduction = mode === "production";
    // Only load nodemon-webpack-plugin in development mode
    const NodemonPlugin = isProduction ? null : require("nodemon-webpack-plugin");

    return {
    mode,
    externals: nodeExternals(),
    target: "node",
    context: path.resolve(__dirname, "src"),
    entry: "./main.ts",
    output: {
        filename: "server.js",
        path: path.resolve(__dirname, "dist"),
        publicPath: "dist",
    },
    resolve: {
        plugins: [new TsconfigPathsPlugin()],
        extensions: [".ts", ".js"],
    },
    module: {
        rules: [
            {
                test: /\.ts?$/,
                exclude: /(__tests__|\.spec\.ts$|\.test\.ts$)/,
                loader: "ts-loader",
                options: {
                    configFile: "tsconfig.build.json",
                },
            },
        ],
    },
    stats: {
        warnings: true,
        errors: true,
        errorDetails: true,
    },
    plugins: [
        // Only use NodemonPlugin in development mode
        ...(isProduction ? [] : [new NodemonPlugin({
            stdin: false,
            watch: [path.resolve("./dist"), ".env"],
        })]),
    ],
    optimization: {
        minimize: true,
        minimizer: [
            new TerserPlugin({
                parallel: 4,
                terserOptions: {
                    keep_classnames: true,
                    keep_fnames: true,
                    mangle: false,
                },
            }),
        ],
    },
    };
};
