import * as cdk from 'aws-cdk-lib';
import {
    aws_certificatemanager,
    aws_cloudfront,
    aws_cloudfront_origins,
    aws_codebuild,
    aws_codepipeline,
    aws_codepipeline_actions,
    aws_route53,
    aws_route53_targets,
    aws_s3,
    aws_s3_deployment,
    CfnOutput,
    Duration,
    RemovalPolicy
} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import {ViewerProtocolPolicy} from "aws-cdk-lib/aws-cloudfront";
import {GitHubTrigger} from "aws-cdk-lib/aws-codepipeline-actions";

export class CdkStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        let domain = "digitalcloudbliss.com";

        const zone = aws_route53.HostedZone.fromLookup(this, "zone", {
            domainName: domain,
        });

        const cloudfront = new aws_cloudfront.OriginAccessIdentity(this, "cloudfront-oai", {
            comment: `oai for ${id}`
        });

        new CfnOutput(this, "site", {value: "https://" + domain});

        const bucket = new aws_s3.Bucket(this, "react-bucket", {
            bucketName: domain,
            publicReadAccess: false,
            blockPublicAccess: aws_s3.BlockPublicAccess.BLOCK_ALL,
            versioned: true,
            autoDeleteObjects: true,
            removalPolicy: RemovalPolicy.DESTROY
        });

        bucket.grantRead(cloudfront);
        new CfnOutput(this, "bucket", {value: bucket.bucketName});

        const certificate = new aws_certificatemanager.Certificate(this, "site-certificate", {
            domainName: domain,
            certificateName: domain + "-cert",
            validation: aws_certificatemanager.CertificateValidation.fromDns(zone),
        });
        new CfnOutput(this, "certificate", {value: certificate.certificateArn});

        const distribution = new aws_cloudfront.Distribution(this, "site-distribution", {
            certificate: certificate,
            domainNames: [domain],
            minimumProtocolVersion: aws_cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
            sslSupportMethod: aws_cloudfront.SSLMethod.SNI,
            defaultRootObject: "index.html",
            defaultBehavior: {
                origin: new aws_cloudfront_origins.S3Origin(bucket, {originAccessIdentity: cloudfront}),
                compress: true,
                viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS
            },
            errorResponses: [{
                httpStatus: 404,
                responseHttpStatus: 404,
                responsePagePath: "/index.html",
                ttl: Duration.minutes(30),
            }]
        });
        new CfnOutput(this, "distribution", {value: distribution.distributionId});

        new aws_route53.ARecord(this, "alias-record", {
            recordName: domain,
            target: aws_route53.RecordTarget.fromAlias(new aws_route53_targets.CloudFrontTarget(distribution)),
            zone
        });

        new aws_s3_deployment.BucketDeployment(this, "bucket-deploy", {
            sources: [aws_s3_deployment.Source.asset("../build")],
            destinationBucket: bucket,
            distribution,
            distributionPaths: ["/*"],
        });

        const sourceOutput = new aws_codepipeline.Artifact();
        const build = new aws_codepipeline.Artifact();

        const pipeline = new aws_codepipeline.Pipeline(this, "react-pipeline", {
            pipelineName: "react-pipeline",
            crossAccountKeys: false,
            restartExecutionOnUpdate: true
        });

        pipeline.addStage({
            stageName: "checkout",
            actions: [
                new aws_codepipeline_actions.GitHubSourceAction({
                    actionName: "checkout-webapp",
                    owner: "audiofile100",
                    repo: "aws-cdk-react",
                    branch: "main",
                    oauthToken: cdk.SecretValue.secretsManager('my-github-token'),
                    output: sourceOutput,
                    trigger: GitHubTrigger.WEBHOOK
                }),
            ],
        })

        pipeline.addStage({
            stageName: "build",
            actions: [
                new aws_codepipeline_actions.CodeBuildAction({
                    actionName: "build-webapp",
                    input: sourceOutput,
                    project: new aws_codebuild.PipelineProject(this, "build-webapp", {
                        projectName: "react-webapp",
                        buildSpec: aws_codebuild.BuildSpec.fromSourceFilename("./cdk/buildspec.yml"),
                        environment: {
                            buildImage: aws_codebuild.LinuxBuildImage.STANDARD_6_0
                        }
                    }),
                    outputs: [build]
                }),
            ],
        });

        pipeline.addStage({
            stageName: "deploy",
            actions: [
                new aws_codepipeline_actions.S3DeployAction({
                    actionName: "deploy-webapp",
                    input: build,
                    bucket: bucket,
                }),
            ],
        });
    }
}
