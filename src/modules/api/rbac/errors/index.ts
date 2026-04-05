import { HttpStatus, HttpException } from "@nestjs/common";

export class RoleAlreadyExistsException extends HttpException {
    constructor(message: string) {
        super(
            {
                success: false,
                message,
            },
            HttpStatus.CONFLICT
        );
    }
}

export class RoleNotFoundException extends HttpException {
    constructor(message: string = "Role not found") {
        super(
            {
                success: false,
                message,
            },
            HttpStatus.NOT_FOUND
        );
    }
}

export class CannotDeleteDefaultRoleException extends HttpException {
    constructor() {
        super(
            {
                success: false,
                message: "Cannot delete default system roles",
            },
            HttpStatus.BAD_REQUEST
        );
    }
}

export class PermissionNotFoundException extends RoleNotFoundException {
    constructor(message: string = "Permission not found") {
        super(message);
    }
}

export class AdminUserAlreadyExistsException extends HttpException {
    constructor(email: string) {
        super(
            {
                success: false,
                message: `Admin user with email ${email} already exists`,
            },
            HttpStatus.CONFLICT
        );
    }
}

export class AdminUserNotFoundException extends HttpException {
    constructor() {
        super(
            {
                success: false,
                message: "Admin user not found",
            },
            HttpStatus.NOT_FOUND
        );
    }
}

export class CannotModifySuperAdminException extends HttpException {
    constructor() {
        super(
            {
                success: false,
                message: "Cannot modify super admin account",
            },
            HttpStatus.FORBIDDEN
        );
    }
}

export class PrivilegeEscalationException extends HttpException {
    constructor() {
        super(
            {
                success: false,
                message: "Only a super admin can assign the super-admin role",
            },
            HttpStatus.FORBIDDEN
        );
    }
}

export class AdminInviteNotFoundException extends HttpException {
    constructor() {
        super(
            {
                success: false,
                message: "Admin invite not found",
            },
            HttpStatus.NOT_FOUND
        );
    }
}

export class AdminInviteAlreadyUsedException extends HttpException {
    constructor() {
        super(
            {
                success: false,
                message: "Admin invite has already been used",
            },
            HttpStatus.BAD_REQUEST
        );
    }
}
