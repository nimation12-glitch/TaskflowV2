import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.models.billing import Plan, PlanCode, Subscription, SubscriptionStatus
from app.models.org import Membership, Role
from app.services import invitations as invitation_service


def _attach_free_subscription(db_session, organization):
    plan = db_session.query(Plan).filter_by(code=PlanCode.FREE).one()
    db_session.add(Subscription(organization_id=organization.id, plan_id=plan.id, status=SubscriptionStatus.ACTIVE))
    db_session.commit()


def test_invite_within_seat_limit_succeeds(db_session, organization):
    _attach_free_subscription(db_session, organization)
    invitation, token = invitation_service.create_invitation(
        db_session, organization.id, uuid.uuid4(), "a@example.com", Role.MEMBER
    )
    assert invitation.invited_email == "a@example.com"
    assert len(token) > 20


def test_invite_beyond_seat_limit_raises(db_session, organization):
    _attach_free_subscription(db_session, organization)  # Free plan: max_members=3
    owner_id = uuid.uuid4()
    db_session.add(Membership(organization_id=organization.id, user_id=owner_id, role=Role.OWNER))
    db_session.commit()

    invitation_service.create_invitation(db_session, organization.id, owner_id, "b@example.com", Role.MEMBER)
    invitation_service.create_invitation(db_session, organization.id, owner_id, "c@example.com", Role.MEMBER)
    # owner (1) + 2 pending invites = 3 seats already == Free plan max_members
    with pytest.raises(invitation_service.SeatLimitExceededError):
        invitation_service.create_invitation(db_session, organization.id, owner_id, "d@example.com", Role.MEMBER)


def test_accept_invitation_wrong_email_rejected(db_session, organization):
    _attach_free_subscription(db_session, organization)
    _, token = invitation_service.create_invitation(
        db_session, organization.id, uuid.uuid4(), "invited@example.com", Role.MEMBER
    )
    with pytest.raises(ValueError):
        invitation_service.accept_invitation(db_session, token, uuid.uuid4(), "someone-else@example.com")


def test_accept_expired_invitation_rejected(db_session, organization):
    _attach_free_subscription(db_session, organization)
    invitation, token = invitation_service.create_invitation(
        db_session, organization.id, uuid.uuid4(), "invited@example.com", Role.MEMBER
    )
    invitation.expires_at = datetime.now(timezone.utc) - timedelta(days=1)
    db_session.commit()

    with pytest.raises(ValueError):
        invitation_service.accept_invitation(db_session, token, uuid.uuid4(), "invited@example.com")


def test_accept_valid_invitation_creates_membership(db_session, organization):
    _attach_free_subscription(db_session, organization)
    _, token = invitation_service.create_invitation(
        db_session, organization.id, uuid.uuid4(), "invited@example.com", Role.MEMBER
    )
    new_user_id = uuid.uuid4()
    membership = invitation_service.accept_invitation(db_session, token, new_user_id, "invited@example.com")
    assert membership.organization_id == organization.id
    assert membership.user_id == new_user_id
    assert membership.role == Role.MEMBER
