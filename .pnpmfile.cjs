function readPackage(pkg, context) {
    // Force all packages to use path-to-regexp 3.3.0
    if (pkg.dependencies && pkg.dependencies['path-to-regexp']) {
        pkg.dependencies['path-to-regexp'] = '3.3.0';
    }
    if (pkg.peerDependencies && pkg.peerDependencies['path-to-regexp']) {
        pkg.peerDependencies['path-to-regexp'] = '3.3.0';
    }
    return pkg;
}

module.exports = {
    hooks: {
        readPackage
    }
};
