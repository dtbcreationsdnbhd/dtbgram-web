# Native APK notification research: AWS cleanup record

The owner requested this cleanup on **21 October 2026** to end the research and avoid ongoing dedicated AWS costs. The dedicated backend is removed and native relay enrollment is disabled in the staging website. This record contains resource identifiers, not credentials. See the [setup and workflow guide](PWA_TO_APK_NOTIFICATIONS_GUIDE.md) to reproduce the architecture.

## Scope and result

Account `277715911124`, region `ap-southeast-1`, cluster `dtbgram`. The user turned off **Offline Notifications** in the test APK before teardown, allowing its normal revoke/unregister flow while the relay was available.

| Dedicated research resource | Identifier | Final status |
| --- | --- | --- |
| ECS service | `dtbgram-native-push-staging-service-for286m2` | Deleted; ECS reports `INACTIVE`, desired/running tasks both `0` |
| Relay task | `c25c9a9c4057490abd97af5a0e24408a` | `STOPPED` at 18:09:20 MYT |
| Owning CloudFormation stack | `ECS-Console-V2-Service-dtbgram-native-push-staging-service-for286m2-dtbgram-2d9943c2` | Deleted; stack lookup confirms absence |
| Task-definition family | `dtbgram-native-push-staging`, revisions `1`–`8` | All deregistered; AWS accepted deletion for all eight, with no failures. Metadata deletion is asynchronous |
| ECR repository | `dtbgram-native-push-staging` | Deleted with all contained images |
| EFS file system | `fs-0ff37a835e72004e1` (`justchat`) | Deleted; file-system lookup confirms absence |
| EFS access point | `fsap-01f4104f262e880f7` | Deleted before file-system removal |
| EFS mount targets | Three in the existing VPC | Deleted before file-system removal |
| EFS automatic backup | Research file system | Disabled before storage removal |
| EFS recovery point | `06c6808e-c25c-4e45-adf6-1d1fba250435` | Deleted; zero recovery points remain for this file system |
| Relay security group | `sg-0f41a6a8df37dca79` | Deleted |
| EFS security group | `sg-04622b16af5e56cda` | Deleted |
| Associated network interfaces | Relay/EFS security-group attachments | Zero remain |
| Execution role and its inline policy | `dtbgram-native-push-staging-execution` | Deleted; AWS-managed execution policy detached and retained globally |
| Task role and its inline policy | `dtbgram-native-push-staging-task` | Deleted |
| Firebase runtime secret | `dtbgram/native-push/staging/firebase` | Scheduled for permanent deletion on **28 October 2026, 18:07:56 MYT**, with a seven-day recovery window |
| CloudWatch log group | `/ecs/dtbgram-native-push-staging` | Deleted |
| Relay target group | `dtbgram-native-push-staging` / `9f31e700eb90775b` | Deleted |
| Research HTTPS listener rule | Priority `5`, suffix `7ed4728fb31c00b2` | Deleted; it matched only the native management/ingress paths |
| Obsolete research website images | `staging-20261021-unread-counts`, `staging-background-20261021` | Their two image digests deleted after checking no live ECS task uses them |
| Staging website relay setting | `NATIVE_PUSH_RELAY_URL` | Empty in local `.env` and the deployed public JavaScript |

The backup vault's protection policy required a temporary deletion exception for the **single research recovery-point ARN**. The original policy was restored immediately and its restored contents were verified. The shared vault and its protection remain.

## Preserved resources

- Existing `dtbgram-web-staging` and `dtbgram-web` ECS services and their authentication sidecars.
- Shared `dtbgram` cluster, `dtbgram-web-alb`, HTTPS listener/certificate, and website target groups.
- All other HTTPS listener rules; their contents match the pre-cleanup inventory.
- Existing VPC, subnets, shared security groups, unrelated repositories/images, unrelated secrets, and unrelated backups.
- The shared AWS-managed EFS backup vault, backup infrastructure, and AWS-managed IAM policies.
- Source code, deployment helpers, Firebase project, Natively app, installed APK, and original local service-account file.

Staging now uses task definition **`dtbgram-web-staging:4`** and image `dtbgram-web:staging`, also tagged `staging-20261021-research-disabled`. Using the existing `staging` image reference keeps the website deployment helper applicable. Production remains on **`dtbgram-web:5`**. Only the staging web container's image reference changed; its sidecar and remaining task settings are preserved.

## Verification

AWS resource verification completed at **18:12:57 MYT on 21 October 2026**; obsolete research website image cleanup completed at **18:14:32 MYT**.

- Relay task stopped; dedicated service inactive and owning stack absent.
- EFS, native ECR repository, log group, dedicated roles, security groups, target group, and research listener rule absent.
- Zero recovery points remain for the deleted file system, and zero research network interfaces remain.
- Both existing web services report one desired/running task and completed rollouts.
- Staging publicly returns HTTP `200` and serves the new build. Inspection of its compiled `TG_NATIVE_PUSH_RELAY_URL` confirms an empty value, so native enrollment is disabled.
- Both staging and production host routes return HTTP `200` when requested through the shared load balancer.
- Direct DNS resolution of `justchats.shop` failed from this machine, so public production DNS reachability was not established. DNS records were not changed during this cleanup.
- Documentation relative links and Markdown fences were checked. The staging Docker build completed. No TypeScript or SCSS source changed in this cleanup, and no test files were added.

## Remaining asynchronous records and costs

The Firebase secret remains recoverable until its scheduled permanent deletion. AWS does **not charge for a secret marked for deletion** during the recovery window. [AWS Secrets Manager deletion](https://docs.aws.amazon.com/secretsmanager/latest/userguide/manage_delete-secret.html)

ECS can retain inactive service/stopped task history and task-definition records marked `DELETE_IN_PROGRESS` while it finishes metadata cleanup. These records are not running Fargate tasks or retained relay storage. All eight native task definitions have no active/inactive revisions available for deployment; deletion requests succeeded.

No running dedicated research compute, EFS data/backups, native image repository, or research logs remain in the verified scope. Charges already incurred can still appear later in billing reports. Existing shared website/load-balancer infrastructure and unrelated resources continue their normal costs. Firebase/Natively subscriptions or other non-AWS charges were not cancelled.

## Resuming research

Native APK notifications are intentionally unavailable after this teardown. Recreate the relay resources using the guide, inject a valid server credential, configure the website relay URL, and pair the APK again. Deleted EFS receiver keys cannot be recovered from the removed backup. Browser/iPhone PWA subscriptions use their independent delivery path.
