"""add gpu_instance_id to credit_transactions

Revision ID: b1d84f6a9e02
Revises: a7c2e91f5b3d
Create Date: 2026-09-13 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b1d84f6a9e02'
down_revision: Union[str, Sequence[str], None] = 'a7c2e91f5b3d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    # No hard FK, matching the existing usage_event_id column on this same
    # table — this is a high-volume ledger and both fields are optional
    # traceability links, not integrity-critical relationships.
    op.add_column('credit_transactions', sa.Column('gpu_instance_id', sa.UUID(), nullable=True))
    op.create_index(
        op.f('ix_credit_transactions_gpu_instance_id'), 'credit_transactions', ['gpu_instance_id'], unique=False
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_credit_transactions_gpu_instance_id'), table_name='credit_transactions')
    op.drop_column('credit_transactions', 'gpu_instance_id')
