import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import { aws_apigateway as apigateway } from 'aws-cdk-lib';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as path from 'path';

export class CartApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -------------------------------------------------------------------------
    // VPC – two AZs, one NAT Gateway (Lambda needs outbound internet access)
    // -------------------------------------------------------------------------
    const vpc = new ec2.Vpc(this, 'CartApiVpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 28,
          name: 'Isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
    });

    // -------------------------------------------------------------------------
    // Security Groups
    // -------------------------------------------------------------------------
    const lambdaSecurityGroup = new ec2.SecurityGroup(
      this,
      'LambdaSecurityGroup',
      {
        vpc,
        description: 'Security group for Cart API Lambda function',
        allowAllOutbound: true,
      },
    );

    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', {
      vpc,
      description: 'Security group for RDS PostgreSQL instance',
      allowAllOutbound: false,
    });

    // Allow Lambda to reach RDS on port 5432
    dbSecurityGroup.addIngressRule(
      lambdaSecurityGroup,
      ec2.Port.tcp(5432),
      'Allow Lambda to connect to PostgreSQL',
    );

    // -------------------------------------------------------------------------
    // RDS PostgreSQL Instance
    // -------------------------------------------------------------------------
    const dbInstance = new rds.DatabaseInstance(this, 'CartApiDb', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_15,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO,
      ),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      securityGroups: [dbSecurityGroup],
      databaseName: 'cartdb',
      // Credentials are auto-generated and stored in Secrets Manager
      credentials: rds.Credentials.fromGeneratedSecret('cartapi_admin'),
      multiAz: false,
      allocatedStorage: 20,
      storageEncrypted: true,
      deletionProtection: false,
      // Allow clean teardown in non-production environments
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // -------------------------------------------------------------------------
    // Lambda Function (NodejsFunction – bundled with esbuild)
    // -------------------------------------------------------------------------
    const lambdaFunction = new lambdaNodejs.NodejsFunction(
      this,
      'CartApiLambda',
      {
        runtime: lambda.Runtime.NODEJS_20_X,
        // Entry point: the serverless adapter in the Nest.js application
        entry: path.join(
          __dirname,
          '../../nodejs-aws-cart-api/src/lambda.ts',
        ),
        handler: 'handler',
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        vpc,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        securityGroups: [lambdaSecurityGroup],
        bundling: {
          // These heavy modules are installed as-is (no esbuild transform) to
          // preserve native bindings and TypeORM / reflect-metadata behaviour.
          nodeModules: [
            'pg',
            'pg-native',
            'typeorm',
            '@nestjs/typeorm',
            'reflect-metadata',
          ],
          // Keep the AWS SDK out of the bundle – it is provided by the runtime.
          externalModules: ['@aws-sdk/*'],
          tsconfig: path.join(
            __dirname,
            '../../nodejs-aws-cart-api/tsconfig.json',
          ),
          // esbuild target aligned with NODEJS_20_X runtime
          target: 'node20',
          // Required for NestJS decorators
          keepNames: true,
        },
        environment: {
          NODE_ENV: 'production',
          // Connection details (non-secret)
          DB_HOST: dbInstance.instanceEndpoint.hostname,
          DB_PORT: '5432',
          DB_NAME: 'cartdb',
          // The ARN of the Secrets Manager secret that holds username/password
          DB_SECRET_ARN: dbInstance.secret!.secretArn,
        },
      },
    );

    // Allow Lambda to read the RDS-generated credentials secret
    dbInstance.secret!.grantRead(lambdaFunction);

    // -------------------------------------------------------------------------
    // API Gateway – proxies all requests to Lambda
    // -------------------------------------------------------------------------
    const api = new apigateway.RestApi(this, 'NestApi', {
      restApiName: 'Nest Service',
      description: 'This service serves a Nest.js application.',
      deployOptions: {
        stageName: 'prod',
      },
      // Return proper CORS headers on 4xx/5xx from the gateway itself
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
      },
    });

    const getLambdaIntegration = new apigateway.LambdaIntegration(
      lambdaFunction,
      {
        requestTemplates: { 'application/json': '{ "statusCode": "200" }' },
      },
    );

    // Catch-all proxy resource
    api.root.addProxy({
      defaultIntegration: getLambdaIntegration,
      anyMethod: true,
    });

    // -------------------------------------------------------------------------
    // Stack Outputs
    // -------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: api.url,
      description: 'API Gateway base URL',
      exportName: 'CartApiUrl',
    });

    new cdk.CfnOutput(this, 'DbEndpoint', {
      value: dbInstance.instanceEndpoint.hostname,
      description: 'RDS PostgreSQL endpoint',
      exportName: 'CartApiDbEndpoint',
    });

    new cdk.CfnOutput(this, 'DbSecretArn', {
      value: dbInstance.secret!.secretArn,
      description: 'Secrets Manager ARN for DB credentials',
      exportName: 'CartApiDbSecretArn',
    });
  }
}
