#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CartApiStack } from '../lib/cart-api-stack';

const app = new cdk.App();

new CartApiStack(app, 'CartApiStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'eu-west-1',
  },
  description: 'Cart API Stack – Lambda, API Gateway, RDS PostgreSQL',
});
