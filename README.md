## Description

This is the core service of Resolve web service App. The API currently support all the functionalities that powers the app.

## Install Dependencies

First, clone the repo to your working directory. Make sure you have pnpm globally installed on your system. Run the below command

```bash
$ pnpm install
```

## Install husky

```bash
$ pnpm run husky:install
```

## Running the app

```bash
# development/watch mode
$ pnpm run start:dev

# production mode
$ pnpm run start:prod
```

## Test

```bash
# unit tests
$ pnpm test

# e2e tests
$ pnpm test:e2e

# test coverage
$ pnpm test:cov
```
